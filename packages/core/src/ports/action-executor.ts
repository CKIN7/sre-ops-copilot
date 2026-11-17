export interface RollbackCommand {
  service: string;
  toVersion: string;
  reason: string;
  idempotencyKey: string;
}

export interface FlagCommand {
  flag: string;
  value: string | number | boolean;
  reason: string;
  idempotencyKey: string;
}

export interface SilenceCommand {
  alertId: string;
  durationSeconds: number;
  reason: string;
  idempotencyKey: string;
}

export type ActionStatus = "applied" | "noop" | "conflict" | "timeout" | "partial";

export interface ActionResult {
  effectId: string;
  status: ActionStatus;
  observedState: unknown;
  verified: boolean;
  durationMs: number;
  evidence: string[];
}

/**
 * Puerto de ejecución de acciones (docs/plan.md §6.1). Las implementaciones
 * (`simulated`, `sandbox`) entran con su épica; el contrato vive en `core` para que
 * gateway, orquestador y evals dependan de una sola definición.
 */
export interface ActionExecutor {
  rollback(command: RollbackCommand): Promise<ActionResult>;
  setFlag(command: FlagCommand): Promise<ActionResult>;
  silenceAlert(command: SilenceCommand): Promise<ActionResult>;
}
