import type { ProposalDetail } from "./proposals.js";

/**
 * Modelo del control plane para runs y timeline (docs/plan.md §5 y §7).
 *
 * Los tipos viven en `core` porque los comparten API, orquestador, repositorios,
 * CLI y UI. Las fechas cruzan capas como ISO 8601: el driver devuelve `Date`, pero el
 * dominio no se ata a `pg` ni a Drizzle.
 */

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "degraded",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ["cli", "api", "ui", "schedule"] as const;

export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const STEP_KINDS = ["model", "tool"] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export const TOOL_CALL_STATUSES = ["pending", "ok", "error"] as const;

export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  status: RunStatus;
  trigger: RunTrigger;
  goal: string;
  startedAt: string | null;
  endedAt: string | null;
  costCents: number;
  tokensIn: number;
  tokensOut: number;
  errorCode: string | null;
  createdAt: string;
}

export interface RunStep {
  id: string;
  runId: string;
  idx: number;
  kind: StepKind;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number;
  costCents: number;
  payloadRef: string | null;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  stepId: string;
  tool: string;
  argsRedacted: unknown;
  resultHash: string | null;
  status: ToolCallStatus;
  errorCode: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TimelineStep extends RunStep {
  toolCalls: ToolCall[];
}

export interface RunTimeline {
  run: Run;
  steps: TimelineStep[];
  /**
   * Las escrituras que propuso este run, con su decisión y su efecto. Es lo que
   * permite ver en la timeline que un `apply` quedó `applied` o `degraded`
   * (docs/plan.md §11).
   */
  proposals: ProposalDetail[];
}
