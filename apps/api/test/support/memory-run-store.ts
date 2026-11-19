import { randomUUID } from "node:crypto";

import type {
  Run,
  RunStep,
  RunTimeline,
  TimelineStep,
  ToolCall,
} from "@beacon/core/domain/runs";
import type {
  AppendStepInput,
  AppendToolCallInput,
  CompleteToolCallInput,
  CreateRunRecordInput,
  FinishRunRecordInput,
  RunStore,
} from "@beacon/core/ports/run-store";

/** Store en memoria para tests de HTTP/CLI; no sustituye al de Postgres. */
export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, Run>();
  readonly steps: RunStep[] = [];
  readonly toolCalls: ToolCall[] = [];
  readonly events: string[] = [];
  finished: FinishRunRecordInput | undefined;

  async createRun(input: CreateRunRecordInput): Promise<Run> {
    this.events.push("createRun");
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
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  async markRunRunning(runId: string, startedAt: string): Promise<void> {
    this.events.push("markRunRunning");
    const run = this.runs.get(runId);
    if (run) {
      this.runs.set(runId, { ...run, status: "running", startedAt });
    }
  }

  async finishRun(runId: string, input: FinishRunRecordInput): Promise<void> {
    this.events.push("finishRun");
    this.finished = input;
    const run = this.runs.get(runId);
    if (run) {
      this.runs.set(runId, {
        ...run,
        status: input.status,
        endedAt: input.endedAt,
        errorCode: input.errorCode,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        costCents: input.costCents,
      });
    }
  }

  async appendStep(input: AppendStepInput): Promise<RunStep> {
    this.events.push(`appendStep:${input.kind}`);
    const step: RunStep = {
      id: randomUUID(),
      runId: input.runId,
      idx: input.idx,
      kind: input.kind,
      model: input.model,
      promptVersion: input.promptVersion,
      latencyMs: input.latencyMs,
      costCents: input.costCents,
      payloadRef: input.payloadRef,
      createdAt: new Date().toISOString(),
    };
    this.steps.push(step);
    return step;
  }

  async appendToolCall(input: AppendToolCallInput): Promise<ToolCall> {
    this.events.push("appendToolCall");
    const call: ToolCall = {
      id: randomUUID(),
      stepId: input.stepId,
      tool: input.tool,
      argsRedacted: input.argsRedacted,
      resultHash: null,
      status: input.status,
      errorCode: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.toolCalls.push(call);
    return call;
  }

  async completeToolCall(input: CompleteToolCallInput): Promise<void> {
    this.events.push(`completeToolCall:${input.status}`);
    const index = this.toolCalls.findIndex((call) => call.id === input.toolCallId);
    const call = this.toolCalls[index];
    if (!call) {
      return;
    }
    this.toolCalls[index] = {
      ...call,
      status: input.status,
      resultHash: input.resultHash,
      errorCode: input.errorCode,
      finishedAt: input.finishedAt,
    };
  }

  async getTimeline(runId: string, tenantId: string): Promise<RunTimeline | null> {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId) {
      return null;
    }

    const steps: TimelineStep[] = this.steps
      .filter((step) => step.runId === runId)
      .sort((left, right) => left.idx - right.idx)
      .map((step) => ({
        ...step,
        toolCalls: this.toolCalls.filter((call) => call.stepId === step.id),
      }));

    return { run, steps };
  }
}