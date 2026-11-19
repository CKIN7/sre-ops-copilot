import type {
  Run,
  RunStatus,
  RunTimeline,
  RunTrigger,
  RunStep,
  StepKind,
  ToolCall,
  ToolCallStatus,
} from "../domain/runs.js";

export interface CreateRunRecordInput {
  tenantId: string;
  agentId: string;
  trigger: RunTrigger;
  goal: string;
}

export interface FinishRunRecordInput {
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled" | "degraded">;
  endedAt: string;
  errorCode: string | null;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

export interface AppendStepInput {
  runId: string;
  idx: number;
  kind: StepKind;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number;
  costCents: number;
  payloadRef: string | null;
}

export interface AppendToolCallInput {
  stepId: string;
  tool: string;
  argsRedacted: unknown;
  status: ToolCallStatus;
  idempotencyKey: string | null;
}

export interface CompleteToolCallInput {
  toolCallId: string;
  status: Exclude<ToolCallStatus, "pending">;
  resultHash: string | null;
  errorCode: string | null;
  finishedAt: string;
}

/**
 * Puerto de persistencia del control plane. La implementación (Drizzle/Postgres)
 * vive en `apps/api`; el orquestador solo conoce esta interfaz.
 */
export interface RunStore {
  createRun(input: CreateRunRecordInput): Promise<Run>;
  markRunRunning(runId: string, startedAt: string): Promise<void>;
  finishRun(runId: string, input: FinishRunRecordInput): Promise<void>;
  appendStep(input: AppendStepInput): Promise<RunStep>;
  appendToolCall(input: AppendToolCallInput): Promise<ToolCall>;
  completeToolCall(input: CompleteToolCallInput): Promise<void>;
  getTimeline(runId: string, tenantId: string): Promise<RunTimeline | null>;
}
