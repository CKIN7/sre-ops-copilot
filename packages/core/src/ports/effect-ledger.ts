import type { EffectRecord, EffectStatus } from "../domain/proposals.js";

/**
 * Registro de los efectos de una escritura (ADR-004 decisión 5, ADR-005).
 *
 * `reserveEffect` es la pieza que da idempotencia: la fila se inserta **antes** de
 * llamar al ejecutor y la clave es única. Si la reserva devuelve `reserved=false`, el
 * efecto ya existía y la escritura **no** se vuelve a ejecutar: se devuelve lo que
 * quedó registrado la primera vez.
 *
 * La implementación (Drizzle/Postgres) vive en `apps/api/src/adapters`.
 */

export { EFFECT_STATUSES } from "../domain/proposals.js";
export type { EffectRecord, EffectStatus } from "../domain/proposals.js";

export interface ReserveEffectInput {
  proposalId: string;
  tenantId: string;
  idempotencyKey: string;
  executor: string;
  effectId: string;
}

export interface EffectReservation {
  /** `true` = esta llamada reservationó el efecto y puede ejecutarlo. */
  reserved: boolean;
  effect: EffectRecord;
}

export interface EffectOutcome {
  status: Exclude<EffectStatus, "pending">;
  verified: boolean;
  observedState: unknown;
  evidence: string[];
  durationMs: number;
  errorCode: string | null;
  appliedAt: string;
}

export interface EffectLedger {
  reserveEffect(input: ReserveEffectInput): Promise<EffectReservation>;
  completeEffect(effectId: string, outcome: EffectOutcome): Promise<EffectRecord>;
  /** El efecto de una propuesta, si ya se ejecutó. */
  getEffectForProposal(proposalId: string): Promise<EffectRecord | null>;
}
