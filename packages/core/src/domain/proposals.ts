import type { ProposalStatus, RiskLevel, WriteKind } from "./write-tools.js";
import type { WriteToolName } from "../schemas/writes.js";

export { PROPOSAL_STATUSES } from "./write-tools.js";
export type { ProposalStatus } from "./write-tools.js";

/**
 * Tipos de las propuestas, sus aprobaciones y sus efectos (ADR-004).
 *
 * Viven en el dominio y no en los puertos porque los comparten la API, la CLI y la
 * UI: el puerto los consume, no los define. La dirección correcta es
 * `domain -> ports`, nunca al reves.
 */

export type ApprovalDecision = "approved" | "rejected";

export interface ProposalRecord {
  id: string;
  /** Id de la aprobación, acuñado al proponer: la referencia no cambia al decidir. */
  approvalId: string;
  tenantId: string;
  kind: WriteKind;
  tool: WriteToolName;
  status: ProposalStatus;
  risk: RiskLevel;
  /** Qué se toca: el servicio, la flag o la alerta. */
  target: string;
  /** Argumentos **ya redactados**: es lo que se ejecutará. */
  args: unknown;
  diff: unknown;
  blastRadius: unknown;
  evidence: string[];
  idempotencyKey: string;
  /** `null` = propuesta abierta fuera de un run. */
  runId: string | null;
  /** La tool call que propuso la escritura; `null` si se abrió desde la API. */
  toolCallId: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  proposalId: string;
  tenantId: string;
  /** `user:<uuid>`: el id resuelto server-side, nunca un email. */
  approver: string;
  decision: ApprovalDecision;
  reason: string | null;
  decidedAt: string;
}

export const EFFECT_STATUSES = [
  "pending",
  "applied",
  "noop",
  "conflict",
  "timeout",
  "partial",
  "failed",
] as const;

export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export interface EffectRecord {
  id: string;
  proposalId: string;
  tenantId: string;
  idempotencyKey: string;
  executor: string;
  /** Estable por `idempotencyKey`: lo deriva de la clave, no de un UUID aleatorio. */
  effectId: string;
  status: EffectStatus;
  /** `false` = se aplicó pero no se comprobó: nunca es un éxito. */
  verified: boolean;
  observedState: unknown;
  evidence: string[];
  durationMs: number;
  errorCode: string | null;
  createdAt: string;
  appliedAt: string | null;
}

/**
 * Una propuesta con su decisión y su efecto: lo que la UI necesita para decidir y
 * para mostrar qué pasó después.
 */
export interface ProposalDetail {
  proposal: ProposalRecord;
  approval: ApprovalRecord | null;
  effect: EffectRecord | null;
}
