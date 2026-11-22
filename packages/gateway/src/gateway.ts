import { createHash } from "node:crypto";

import { trace } from "@opentelemetry/api";
import { stableStringify } from "@beacon/core/domain/json";
import { AppError } from "@beacon/core/errors/app-error";
import type { AuditEntry, AuditLog } from "@beacon/core/ports/audit-log";
import type { BudgetPort, BudgetLimits, BudgetUsage, ToolUsageMeter } from "@beacon/core/ports/budget";
import { ZERO_USAGE_METER } from "@beacon/core/ports/budget";
import type { DemoSessionStore } from "@beacon/core/ports/demo-session";
import type { ProposalStore } from "@beacon/core/ports/proposal-store";
import type { RateLimiter } from "@beacon/core/ports/rate-limiter";
import type { ToolCallResult, ToolGateway } from "@beacon/core/ports/tool-gateway";
import { redactValue } from "@beacon/core/redaction/redact";
import { schemaHashFor } from "@beacon/core/schemas/schema-hash";
import { READ_TOOL_NAMES } from "@beacon/core/schemas/tools";
import {
  WRITE_TOOL_NAMES,
  actionPlanSchema,
  type WriteToolName,
} from "@beacon/core/schemas/writes";

import { assertToolAllowed, resolveAllowedTools } from "./allowlist.js";
import { buildAuditEntry } from "./audit.js";
import { HttpMcpTransport } from "./http-transport.js";
import type { McpTransport } from "./transport.js";
import { parseToolArgs } from "./validate.js";
import { createProposalWriter, type ProposalWriter } from "./write-policy.js";

export interface CreateToolGatewayOptions {
  transport: McpTransport;
  /** `agents.allowed_tools` resuelto server-side para este run. */
  allowedTools: readonly string[];
  /** Audit append-only. Obligatorio: una tool call sin auditar no se ejecuta. */
  audit: AuditLog;
  /** Rate limit con ventana deslizante. Obligatorio: sin él no hay techo. */
  rateLimiter: RateLimiter;
  /**
   * Presupuesto con reserva atómica. Si se omite, el gateway no reserva (solo
   * debería ocurrir en tests unitarios del resto de políticas); la API siempre lo
   * inyecta.
   */
  budget?: BudgetPort;
  /** Límites que se aplican a cada reserva; obligatorios si hay `budget`. */
  budgetLimits?: BudgetLimits;
  /** Medidor de uso; por defecto cero porque no hay proveedor real. */
  usageMeter?: ToolUsageMeter;
  /** `agent:<nombre>` de quien actúa. */
  actor: string;
  /**
   * Persistencia de propuestas. Obligatoria si la allowlist incluye tools de
   * escritura: sin ella no hay dónde dejar el plan que se va a aprobar.
   */
  proposals?: ProposalStore;
  /** Aviso de fallos no fatales (por ejemplo, no se pudo auditar una denegación). */
  onError?: (error: unknown) => void;
  /** Politica de la demo publica; `undefined` = instancia privada. */
  demo?: DemoGatewayPolicy;
}

/**
 * Politica de la demo publica (plan §4.11). El gateway es el punto de enforcement:
 * la UI solo muestra el estado. La sesion y la IP llegan del borde HTTP, nunca del
 * modelo.
 */
export interface DemoGatewayPolicy {
  sessions: DemoSessionStore;
  sessionId: string;
  ip: string;
  /** Techo de coste acumulado por sesion, en centimos. */
  maxCostCents: number;
  /** Techo de steps por sesion. */
  maxSteps: number;
  sessionTtlMs: number;
  dailyLimit: number;
  /** Fallos de dependencia consecutivos que disparan REPLAY_ONLY. */
  failureThreshold: number;
  /** `true` si la instancia arranco en REPLAY_ONLY=1. */
  replayOnly: boolean;
  /** Transporte de fixtures; obligatorio para que el fallback sirva runs. */
  replayTransport?: McpTransport;
}

/** ¿Es una tool de escritura (fase 1) o de lectura? */
export function isWriteTool(tool: string): tool is WriteToolName {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(tool);
}

/**
 * Gateway v0: allowlist + validación + rate limit + presupuesto + audit + llamada.
 *
 * Es la única puerta del orquestador hacia `mcp-ops`. El orden de las comprobaciones
 * es el que cuenta: primero la allowlist, después el contrato de los argumentos,
 * después el rate limit, la reserva de presupuesto, el audit de la decisión y solo
 * entonces la llamada. Nada llega a `mcp-ops` sin haber pasado por las anteriores.
 *
 * **Fallar cerrado:** si no se puede escribir la entrada de audit, la llamada no se
 * ejecuta y la reserva se libera. Un gateway que deja pasar tool calls sin registrar
 * es exactamente el agujero que este proyecto quiere cerrar. La denegación, en
 * cambio, se audita en segundo plano: si esa escritura falla, la denegación sigue
 * siendo denegación.
 *
 * El rate limit va antes que el presupuesto: una tool denegada por límite no reserva
 * ni liquida nada. El presupuesto reserva antes de la llamada y liquida después con
 * el uso observado; una llamada que falla también se liquida para no dejar la reserva
 * abierta.
 *
 * Las tools de escritura (`propose_*`) no mutan nada: calculan un plan. El gateway es
 * quien lo persiste como propuesta y devuelve el `approval_id` con el que un humano
 * puede aprobarlo (ADR-004).
 */
export function createToolGateway(options: CreateToolGatewayOptions): ToolGateway {
  const allowed = new Set(resolveAllowedTools(options.allowedTools));
  const { audit, rateLimiter, actor, onError } = options;

  const needsProposals = [...allowed].some((tool) => isWriteTool(tool));
  if (needsProposals && !options.proposals) {
    throw new AppError(
      "internal",
      "the allowlist includes write tools but no proposal store was provided",
    );
  }

  if (options.budget && !options.budgetLimits) {
    throw new AppError("internal", "a budget port requires budget limits");
  }

  const usageMeter = options.usageMeter ?? ZERO_USAGE_METER;

  const writer: ProposalWriter | null = options.proposals
    ? createProposalWriter({ proposals: options.proposals, audit, actor, onError })
    : null;

  const auditCall = async (
    action: "tool.call.allowed" | "tool.call.denied" | "tool.call.error" | "tool.call.result",
    tool: string,
    context: Parameters<ToolGateway["call"]>[2],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const entry: AuditEntry = buildAuditEntry({
      tenantId: context.tenantId,
      actor,
      action,
      tool,
      runId: context.runId,
      userId: context.userId,
      stepIdx: context.stepIdx,
      payload,
    });
    await audit.append(entry);
  };

  const auditBestEffort = async (
    action: "tool.call.denied" | "tool.call.error",
    tool: string,
    context: Parameters<ToolGateway["call"]>[2],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await auditCall(action, tool, context, payload);
    } catch (error) {
      onError?.(error);
    }
  };

  return {
    async call(tool, args, context): Promise<ToolCallResult> {
      try {
        assertToolAllowed(tool, allowed);
      } catch (error) {
        await auditBestEffort("tool.call.denied", tool, context, {
          reason: error instanceof AppError ? error.code : "unknown",
          args,
        });
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = parseToolArgs(tool, args);
      } catch (error) {
        await auditBestEffort("tool.call.denied", tool, context, {
          reason: error instanceof AppError ? error.code : "unknown",
          args,
        });
        throw error;
      }

      // Politica de demo (plan §4.11): sesion anonima, techo diario y breaker. Se
      // aplica en el gateway, antes de gastar rate limit o presupuesto.
      let replayOnly = false;
      if (options.demo) {
        // Allowlist de la demo: las 10 tools de lectura y las propose_*; nada mas,
        // aunque el control plane del agente tenga una lista mas amplia.
        const demoTool =
          (READ_TOOL_NAMES as readonly string[]).includes(tool) || isWriteTool(tool);
        if (!demoTool) {
          await auditBestEffort("tool.call.denied", tool, context, {
            reason: "demo_tool_not_allowed",
          });
          throw new AppError("forbidden", `DEMO_MODE: tool no permitida: ${tool}`, {
            statusCode: 403,
            details: { reason: "demo_tool_not_allowed" },
          });
        }

        const touched = await options.demo.sessions.touch({
          sessionId: options.demo.sessionId,
          ip: options.demo.ip,
          now: Date.now(),
          ttlMs: options.demo.sessionTtlMs,
          dailyLimit: options.demo.dailyLimit,
        });
        if (!touched.allowed) {
          await auditBestEffort("tool.call.denied", tool, context, {
            reason: `demo_${touched.reason ?? "denied"}`,
            limit: touched.limit,
            observed: touched.observed,
          });
          throw new AppError("rate_limited", `demo denied: ${touched.reason ?? "unknown"}`, {
            statusCode: 429,
            details: {
              reason: touched.reason,
              limit: touched.limit,
              observed: touched.observed,
            },
          });
        }

        replayOnly = options.demo.replayOnly || touched.state?.replayOnly === true;

        // En REPLAY_ONLY no se ejecuta ninguna escritura: ni siquiera una propuesta.
        if (replayOnly && isWriteTool(tool)) {
          await auditBestEffort("tool.call.denied", tool, context, {
            reason: "replay_only_write",
          });
          throw new AppError("forbidden", "REPLAY_ONLY: no se ejecutan escrituras", {
            statusCode: 403,
            details: { reason: "replay_only" },
          });
        }
      }

      // Rate limit antes de la auditoría y de la llamada: una llamada rechazada por
      // límite no consume presupuesto y no sale a la red.
      const decision = await rateLimiter.consume({
        tenantId: context.tenantId,
        runId: context.runId,
        tool,
        ...(options.demo
          ? { sessionId: options.demo.sessionId, ip: options.demo.ip }
          : {}),
      });

      if (!decision.allowed) {
        await auditBestEffort("tool.call.denied", tool, context, {
          reason: "rate_limited",
          scope: decision.scope,
          limit: decision.limit,
          observed: decision.observed,
        });
        throw new AppError(
          "rate_limited",
          `rate limit exceeded for ${decision.scope ?? "unknown"} scope`,
          {
            statusCode: 429,
            details: {
              scope: decision.scope,
              limit: decision.limit,
              observed: decision.observed,
              retryAfterMs: decision.retryAfterMs,
            },
          },
        );
      }

      const estimate = normalizeUsage(
        usageMeter.estimate({
          tool,
          args: parsed,
          tenantId: context.tenantId,
          runId: context.runId,
        }),
      );
      const budgetKey = budgetKeyFor(tool, parsed, context);

      // Presupuesto de la sesion anonima: se cobra con reserva atomica en Postgres
      // (no un contador en memoria). Es independiente del presupuesto del tenant,
      // que sigue aplicandose mas abajo.
      if (options.demo) {
        const charged = await options.demo.sessions.charge({
          sessionId: options.demo.sessionId,
          now: Date.now(),
          ttlMs: options.demo.sessionTtlMs,
          costCents: estimate.costCents,
          maxCostCents: options.demo.maxCostCents,
          maxSteps: options.demo.maxSteps,
        });
        if (!charged.allowed) {
          await auditBestEffort("tool.call.denied", tool, context, {
            reason: `demo_${charged.reason ?? "budget_exceeded"}`,
            limit: charged.limit,
            observed: charged.observed,
          });
          throw new AppError(
            charged.reason === "session_budget" ? "budget_exceeded" : "rate_limited",
            `demo session limit: ${charged.reason ?? "unknown"}`,
            {
              statusCode: charged.reason === "session_budget" ? 402 : 429,
              details: {
                reason: charged.reason,
                limit: charged.limit,
                observed: charged.observed,
              },
            },
          );
        }
      }
      let reservationId: string | null = null;
      let reservationSettled = false;

      const settleReservation = async (usage: BudgetUsage): Promise<void> => {
        if (!options.budget || reservationId === null || reservationSettled) {
          return;
        }
        await options.budget.settle({
          reservationId,
          usage,
          kind: "tool_call",
          tool,
        });
        reservationSettled = true;
      };

      // Reserva atómica antes de la llamada. Si no hay presupuesto, la tool no se
      // ejecuta y la denegación se audita con el ámbito que la rebasó.
      if (options.budget && options.budgetLimits) {
        const reservation = await options.budget.reserve({
          tenantId: context.tenantId,
          runId: context.runId,
          idempotencyKey: budgetKey,
          estimate,
          limits: options.budgetLimits,
        });

        if (!reservation.allowed) {
          await auditBestEffort("tool.call.denied", tool, context, {
            reason: "budget_exceeded",
            dimension: reservation.dimension,
            scope: reservation.scope,
            limit: reservation.limit,
            observed: reservation.observed,
            requested: reservation.requested,
          });
          throw new AppError(
            "budget_exceeded",
            `budget exceeded for ${reservation.scope} scope (${reservation.dimension})`,
            {
              statusCode: 402,
              details: {
                scope: reservation.scope,
                dimension: reservation.dimension,
                limit: reservation.limit,
                observed: reservation.observed,
                requested: reservation.requested,
              },
            },
          );
        }

        reservationId = reservation.reservation.id;
        trace.getActiveSpan()?.setAttributes({
          "budget.reservation_id": reservation.reservation.id,
          "budget.estimated_cost_cents": estimate.costCents,
          "budget.estimated_tokens_in": estimate.tokensIn,
          "budget.estimated_tokens_out": estimate.tokensOut,
          "budget.replayed": reservation.replayed,
        });
      }

      // La auditoría va antes de la llamada: si falla, la tool no se invoca y la
      // reserva se libera sin uso.
      try {
        await auditCall("tool.call.allowed", tool, context, { args: parsed });
      } catch (error) {
        if (reservationId !== null) {
          await options.budget?.release(reservationId).catch(onError);
        }
        throw error;
      }

      const startedAt = performance.now();
      const transport = replayOnly ? options.demo?.replayTransport : options.transport;
      if (!transport) {
        await auditBestEffort("tool.call.error", tool, context, {
          reason: "replay_fixtures_missing",
        });
        throw new AppError(
          "upstream_error",
          "REPLAY_ONLY sin fixtures de replay: no se llama a mcp-ops",
          { statusCode: 503, details: { reason: "replay_only" } },
        );
      }

      try {
        const raw = await transport.callTool({ name: tool, args: parsed });
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
        const usage = { ...estimate, wallMs: latencyMs };

        // Defensa en profundidad: las tools ya redactan, pero el gateway no confía
        // en ese contrato. Lo que sale hacia el modelo y hacia el audit va redactado.
        const result = redactValue(raw);

        await auditCall("tool.call.result", tool, context, {
          args: parsed,
          latency_ms: latencyMs,
          result,
        });
        await settleReservation(usage);
        trace.getActiveSpan()?.setAttributes({
          "budget.settled_cost_cents": usage.costCents,
          "budget.settled_tokens_in": usage.tokensIn,
          "budget.settled_tokens_out": usage.tokensOut,
          "budget.settled_wall_ms": usage.wallMs,
        });

        if (!isWriteTool(tool)) {
          return { result, latencyMs, usage };
        }

        // Fase 1: el plan se persiste como propuesta y queda pendiente de un humano.
        if (!writer) {
          throw new AppError("internal", "no proposal store configured for write tools");
        }

        const plan = actionPlanSchema.safeParse(result);
        if (!plan.success) {
          throw new AppError("upstream_error", `${tool} returned an invalid action plan`, {
            statusCode: 502,
            details: plan.error.issues,
          });
        }

        const proposal = await writer.persist({
          context,
          tool,
          args: parsed,
          plan: plan.data,
        });

        return {
          result: {
            proposal_id: proposal.id,
            approval_id: proposal.approvalId,
            status: proposal.status,
            plan: plan.data,
          },
          latencyMs,
          usage,
        };
      } catch (error) {
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
        if (options.demo) {
          await options.demo.sessions
            .recordFailure({
              sessionId: options.demo.sessionId,
              now: Date.now(),
              threshold: options.demo.failureThreshold,
            })
            .catch(onError);
        }
        try {
          await settleReservation({ ...estimate, wallMs: latencyMs });
        } catch (settleError) {
          onError?.(settleError);
        }
        await auditBestEffort("tool.call.error", tool, context, {
          args: parsed,
          error_code: error instanceof AppError ? error.code : "unknown",
        });
        throw error;
      }
    },
  };
}

/** Huella estable para que un reintento de la misma llamada no reserve dos veces. */
function budgetKeyFor(
  tool: string,
  args: unknown,
  context: Parameters<ToolGateway["call"]>[2],
): string {
  if (context.toolCallId) {
    return `tool_call:${context.toolCallId}`;
  }
  const digest = createHash("sha256")
    .update(stableStringify({ tool, args }), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `budget:${context.tenantId}:${context.runId ?? "no-run"}:${context.stepIdx}:${digest}`;
}

function normalizeUsage(usage: BudgetUsage): BudgetUsage {
  return {
    tokensIn: Math.max(0, Math.trunc(usage.tokensIn)),
    tokensOut: Math.max(0, Math.trunc(usage.tokensOut)),
    costCents: Math.max(0, Math.trunc(usage.costCents)),
    wallMs: Math.max(0, Math.trunc(usage.wallMs)),
  };
}

/** Huella del contrato de la tool para los spans; no se calcula si no hay span. */
export function toolSchemaHash(tool: string): string {
  return schemaHashFor(tool);
}

export interface CreateHttpToolGatewayOptions {
  /** URL del endpoint `POST /mcp` de mcp-ops. */
  url: string;
  /** Bearer de servicio; nunca es una credencial de usuario. */
  token: string;
  /** `agents.allowed_tools` resuelto server-side para este run. */
  allowedTools: readonly string[];
  /** Audit append-only; obligatorio para que el gateway pueda auditar. */
  audit: AuditLog;
  /** Rate limit con ventana deslizante; obligatorio para que haya techo. */
  rateLimiter: RateLimiter;
  /** Presupuesto con reserva atómica; obligatorio en la API. */
  budget?: BudgetPort;
  /** Límites por run y por tenant. */
  budgetLimits?: BudgetLimits;
  /** Medidor de uso inyectable. */
  usageMeter?: ToolUsageMeter;
  /** `agent:<nombre>` de quien actúa. */
  actor: string;
  /** Persistencia de propuestas; obligatoria si hay tools de escritura en la allowlist. */
  proposals?: ProposalStore;
  /** Aviso de fallos no fatales. */
  onError?: (error: unknown) => void;
  timeoutMs?: number;
  /** Politica de la demo publica; `undefined` = instancia privada. */
  demo?: DemoGatewayPolicy;
}

/**
 * Composition del gateway sobre el transporte HTTP. La API no necesita conocer
 * `HttpMcpTransport` ni cómo se presenta el bearer: solo pide un gateway para la
 * allowlist del agente.
 */
export function createHttpToolGateway(options: CreateHttpToolGatewayOptions): ToolGateway {
  return createToolGateway({
    transport: new HttpMcpTransport({
      url: options.url,
      token: options.token,
      timeoutMs: options.timeoutMs,
    }),
    allowedTools: options.allowedTools,
    audit: options.audit,
    rateLimiter: options.rateLimiter,
    budget: options.budget,
    budgetLimits: options.budgetLimits,
    usageMeter: options.usageMeter,
    actor: options.actor,
    proposals: options.proposals,
    onError: options.onError,
    demo: options.demo,
  });
}

export { createActionApplier } from "./apply-policy.js";
export type { ActionApplierOptions } from "./apply-policy.js";
export { createProposalWriter } from "./write-policy.js";
export type { ProposalWriter, ProposalWriterOptions } from "./write-policy.js";
