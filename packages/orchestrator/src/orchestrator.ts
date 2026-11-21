import { createHash } from "node:crypto";

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { stableStringify } from "@beacon/core/domain/json";
import type { RunStatus, RunTrigger } from "@beacon/core/domain/runs";
import { AppError, type AppErrorCode } from "@beacon/core/errors/app-error";
import type { Model, Observation } from "@beacon/core/ports/model";
import type { BudgetUsage } from "@beacon/core/ports/budget";
import type { RunStore } from "@beacon/core/ports/run-store";
import type { ToolGateway } from "@beacon/core/ports/tool-gateway";
import { redactValue } from "@beacon/core/redaction/redact";
import { schemaHashFor } from "@beacon/core/schemas/schema-hash";
import { finalAnswerSchema, type FinalAnswer } from "@beacon/core/schemas/runs";

export interface RunLimits {
  /** Máximo de turnos de modelo; cada turno puede ser tool call o respuesta final. */
  maxModelTurns: number;
  /** Reloj de pared del run completo. */
  maxWallMs: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxModelTurns: 12,
  maxWallMs: 90_000,
};

export type TerminalRunStatus = Extract<
  RunStatus,
  "succeeded" | "failed" | "cancelled" | "degraded"
>;

export interface OrchestratorOptions {
  model: Model;
  gateway: ToolGateway;
  store: RunStore;
  limits?: Partial<RunLimits>;
  /** Inyectable para tests; por defecto el reloj del sistema. */
  now?: () => number;
}

export interface StartRunInput {
  tenantId: string;
  userId: string;
  agentId: string;
  goal: string;
  trigger: RunTrigger;
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  status: TerminalRunStatus;
  answer: FinalAnswer | null;
  errorCode: AppErrorCode | null;
  turns: number;
}

function errorCodeOf(error: unknown): AppErrorCode {
  return error instanceof AppError ? error.code : "internal";
}

function hashResult(result: unknown): string {
  return createHash("sha256").update(stableStringify(result)).digest("hex");
}

function tracer() {
  return trace.getTracer("beacon.orchestrator", "0.1.0");
}

function addUsage(total: BudgetUsage, usage: BudgetUsage | undefined): void {
  if (!usage) {
    return;
  }
  total.tokensIn += usage.tokensIn;
  total.tokensOut += usage.tokensOut;
  total.costCents += usage.costCents;
  total.wallMs += usage.wallMs;
}

/**
 * Loop de investigación v0 (docs/plan.md §5).
 *
 * Cada tool call se escribe en Postgres antes de ejecutarse (write-ahead) y se
 * completa después. El estado del run vive en el store, no en memoria: si el
 * proceso muere, queda una timeline parcial con la tool call en `pending`.
 *
 * Límites: 12 turnos de modelo y 90 s de reloj. Anti-bucle: repetir el par
 * `(tool, args)` aborta el run en vez de gastar presupuesto.
 *
 * v0 es secuencial (una tool por turno) y la cancelación se comprueba entre
 * turnos; el paralelismo, la reanudación y el replay cacheado llegan con el
 * resto del orquestador.
 */
export class Orchestrator {
  readonly #model: Model;
  readonly #gateway: ToolGateway;
  readonly #store: RunStore;
  readonly #limits: RunLimits;
  readonly #now: () => number;

  constructor(options: OrchestratorOptions) {
    this.#model = options.model;
    this.#gateway = options.gateway;
    this.#store = options.store;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
  }

  async run(input: StartRunInput): Promise<RunResult> {
    return tracer().startActiveSpan(
      "run",
      {
        attributes: {
          tenant_id: input.tenantId,
          agent_id: input.agentId,
          trigger: input.trigger,
          goal: input.goal.slice(0, 200),
          model: this.#model.id,
          prompt_version: this.#model.promptVersion,
        },
      },
      async (span) => {
        try {
          return await this.#execute(input);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "run failed",
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async #execute(input: StartRunInput): Promise<RunResult> {
    const startedAtMs = this.#now();
    const run = await this.#store.createRun({
      tenantId: input.tenantId,
      agentId: input.agentId,
      trigger: input.trigger,
      goal: input.goal,
    });
    await this.#store.markRunRunning(run.id, new Date(startedAtMs).toISOString());
    trace.getActiveSpan()?.setAttributes({ run_id: run.id });

    const observations: Observation[] = [];
    const usageTotal: BudgetUsage = {
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
      wallMs: 0,
    };
    const seenCalls = new Set<string>();
    let stepIdx = 0;
    let turns = 0;
    let settled = false;

    const settle = async (
      status: Extract<TerminalRunStatus, "succeeded" | "failed" | "cancelled">,
      errorCode: AppErrorCode | null,
      answer: FinalAnswer | null = null,
    ): Promise<RunResult> => {
      settled = true;
      await this.#store.finishRun(run.id, {
        status,
        endedAt: new Date(this.#now()).toISOString(),
        errorCode,
        tokensIn: usageTotal.tokensIn,
        tokensOut: usageTotal.tokensOut,
        costCents: usageTotal.costCents,
      });
      return { runId: run.id, status, answer, errorCode, turns };
    };

    try {
      for (;;) {
        if (input.signal?.aborted) {
          return await settle("cancelled", null);
        }
        if (turns >= this.#limits.maxModelTurns) {
          return await settle("failed", "budget_exceeded");
        }
        if (this.#now() - startedAtMs > this.#limits.maxWallMs) {
          return await settle("failed", "timeout");
        }

        const turn = turns;
        turns += 1;

        const modelStartedAt = this.#now();
        const decision = await tracer().startActiveSpan(
          "step",
          {
            attributes: {
              tenant_id: input.tenantId,
              run_id: run.id,
              step_idx: stepIdx,
              step_kind: "model",
              model: this.#model.id,
              prompt_version: this.#model.promptVersion,
            },
          },
          async (stepSpan) => {
            try {
              return await this.#model.decide({
                goal: input.goal,
                turn,
                observations,
              });
            } catch (error) {
              stepSpan.recordException(error as Error);
              stepSpan.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            } finally {
              stepSpan.end();
            }
          },
        );
        const modelLatencyMs = this.#now() - modelStartedAt;

        await this.#store.appendStep({
          runId: run.id,
          idx: stepIdx,
          kind: "model",
          model: this.#model.id,
          promptVersion: this.#model.promptVersion,
          latencyMs: modelLatencyMs,
          costCents: 0,
          payloadRef: null,
        });
        stepIdx += 1;

        if (decision.type === "final") {
          const parsed = finalAnswerSchema.safeParse(decision.answer);
          if (!parsed.success) {
            return await settle("failed", "invalid_input");
          }
          return await settle("succeeded", null, parsed.data);
        }

        const callKey = `${decision.tool}\u0000${stableStringify(decision.args)}`;
        if (seenCalls.has(callKey)) {
          return await settle("failed", "loop_detected");
        }
        seenCalls.add(callKey);

        const toolStepIdx = stepIdx;
        stepIdx += 1;
        const step = await this.#store.appendStep({
          runId: run.id,
          idx: toolStepIdx,
          kind: "tool",
          model: null,
          promptVersion: null,
          latencyMs: 0,
          costCents: 0,
          payloadRef: null,
        });

        const toolCall = await this.#store.appendToolCall({
          stepId: step.id,
          tool: decision.tool,
          // Los args pueden traer PII aunque sean de lectura: se persiste redactado.
          argsRedacted: redactValue(decision.args),
          status: "pending",
          idempotencyKey: null,
        });

        let result: unknown;
        try {
          const toolOutcome = await tracer().startActiveSpan(
            "step",
            {
              attributes: {
                tenant_id: input.tenantId,
                run_id: run.id,
                step_idx: toolStepIdx,
                step_kind: "tool",
                tool: decision.tool,
              },
            },
            async (stepSpan) => {
              try {
                return await tracer().startActiveSpan(
                  "tool_call",
                  {
                    attributes: {
                      tenant_id: input.tenantId,
                      user_id: input.userId,
                      agent_id: input.agentId,
                      run_id: run.id,
                      tool_call_id: toolCall.id,
                      step_idx: toolStepIdx,
                      tool: decision.tool,
                      schema_hash: schemaHashFor(decision.tool),
                    },
                  },
                  async (callSpan) => {
                    try {
                      return await this.#gateway.call(decision.tool, decision.args, {
                        tenantId: input.tenantId,
                        userId: input.userId,
                        agentId: input.agentId,
                        runId: run.id,
                        stepIdx: toolStepIdx,
                        // La fila de la tool call ya existe (write-ahead): una
                        // escritura puede engancharse a ella para verse en la timeline.
                        toolCallId: toolCall.id,
                      });
                    } catch (error) {
                      callSpan.recordException(error as Error);
                      callSpan.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: error instanceof Error ? error.message : "tool call failed",
                      });
                      throw error;
                    } finally {
                      callSpan.end();
                    }
                  },
                );
              } catch (error) {
                stepSpan.recordException(error as Error);
                stepSpan.setStatus({ code: SpanStatusCode.ERROR });
                throw error;
              } finally {
                stepSpan.end();
              }
            },
          );
          result = toolOutcome.result;
          addUsage(usageTotal, toolOutcome.usage);
        } catch (error) {          const code = errorCodeOf(error);
          await this.#store.completeToolCall({
            toolCallId: toolCall.id,
            status: "error",
            resultHash: null,
            errorCode: code,
            finishedAt: new Date(this.#now()).toISOString(),
          });
          return await settle("failed", code);
        }

        await this.#store.completeToolCall({
          toolCallId: toolCall.id,
          status: "ok",
          resultHash: hashResult(result),
          errorCode: null,
          finishedAt: new Date(this.#now()).toISOString(),
        });

        observations.push({
          stepIdx: toolStepIdx,
          tool: decision.tool,
          args: decision.args,
          result,
        });
      }
    } catch (error) {
      if (settled) {
        throw error;
      }
      const code = errorCodeOf(error);
      return await settle("failed", code);
    }
  }
}