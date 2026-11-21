import { randomUUID } from "node:crypto";

import type { Run, RunStep, TimelineStep, ToolCall } from "@beacon/core/domain/runs";
import type {
  AppendStepInput,
  AppendToolCallInput,
  CompleteToolCallInput,
  CreateRunRecordInput,
  FinishRunRecordInput,
  RunStore,
} from "@beacon/core/ports/run-store";

/**
 * `RunStore` en memoria para los evals.
 *
 * No persiste nada: el harness no necesita Postgres para medir trayectoria. Guarda
 * los steps y las tool calls para poder afirmar sobre ellas y expone un reloj fijo
 * para que dos ejecuciones del mismo caso den la misma forma.
 */
export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, Run>();
  readonly steps: RunStep[] = [];
  readonly toolCalls: ToolCall[] = [];
  readonly finished: Array<{ runId: string; input: FinishRunRecordInput }> = [];
  #stepSeq = 0;
  #callSeq = 0;

  constructor(private readonly now: () => number = () => Date.parse("2026-11-21T12:00:00.000Z")) {}

  async createRun(input: CreateRunRecordInput): Promise<Run> {
    const run: Run = {
      id: randomUUID(),
      tenantId: input.tenantId,
      agentId: input.agentId,
      status: "queued",
      trigger: input.trigger,
      goal: input.goal,
      startedAt: null,
      endedAt: null,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      errorCode: null,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  async markRunRunning(runId: string, startedAt: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = "running";
      run.startedAt = startedAt;
    }
  }

  async finishRun(runId: string, input: FinishRunRecordInput): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = input.status;
      run.endedAt = input.endedAt;
      run.errorCode = input.errorCode;
      run.costCents = input.costCents;
      run.tokensIn = input.tokensIn;
      run.tokensOut = input.tokensOut;
    }
    this.finished.push({ runId, input });
  }

  async appendStep(input: AppendStepInput): Promise<RunStep> {
    this.#stepSeq += 1;
    const step: RunStep = {
      id: `step-${String(this.#stepSeq).padStart(4, "0")}`,
      runId: input.runId,
      idx: input.idx,
      kind: input.kind,
      model: input.model,
      promptVersion: input.promptVersion,
      latencyMs: input.latencyMs,
      costCents: input.costCents,
      payloadRef: input.payloadRef,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.steps.push(step);
    return step;
  }

  async appendToolCall(input: AppendToolCallInput): Promise<ToolCall> {
    this.#callSeq += 1;
    const call: ToolCall = {
      id: `call-${String(this.#callSeq).padStart(4, "0")}`,
      stepId: input.stepId,
      tool: input.tool,
      argsRedacted: input.argsRedacted,
      resultHash: null,
      status: input.status,
      errorCode: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(this.now()).toISOString(),
      finishedAt: null,
    };
    this.toolCalls.push(call);
    return call;
  }

  async completeToolCall(input: CompleteToolCallInput): Promise<void> {
    const call = this.toolCalls.find((candidate) => candidate.id === input.toolCallId);
    if (call) {
      call.status = input.status;
      call.resultHash = input.resultHash;
      call.errorCode = input.errorCode;
      call.finishedAt = input.finishedAt;
    }
  }

  async getTimeline(runId: string, tenantId: string): Promise<{
    run: Run;
    steps: TimelineStep[];
    proposals: [];
  } | null> {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId) {
      return null;
    }
    return {
      run,
      steps: this.steps
        .filter((step) => step.runId === runId)
        .map((step) => ({
          ...step,
          toolCalls: this.toolCalls.filter((call) => call.stepId === step.id),
        })),
      proposals: [],
    };
  }

  async getRun(runId: string, tenantId: string): Promise<Run | null> {
    const run = this.runs.get(runId);
    return run && run.tenantId === tenantId ? run : null;
  }

  async listRuns(): Promise<Run[]> {
    return [...this.runs.values()];
  }
}
