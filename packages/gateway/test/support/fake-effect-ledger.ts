import { randomUUID } from "node:crypto";

import type {
  EffectLedger,
  EffectOutcome,
  EffectRecord,
  EffectReservation,
  ReserveEffectInput,
} from "@beacon/core/ports/effect-ledger";

/**
 * `EffectLedger` en memoria para los tests del gateway.
 *
 * Reproduce la restricción que da idempotencia: una fila por clave de idempotencia.
 * La segunda reserva de la misma clave devuelve `reserved=false` y el efecto que ya
 * había, que es exactamente lo que hace la tabla en Postgres.
 */
export class FakeEffectLedger implements EffectLedger {
  readonly effects = new Map<string, EffectRecord>();
  /** Veces que se ha pedido reservar con la misma clave (para contar reejecuciones). */
  readonly reservations = new Map<string, number>();

  async reserveEffect(input: ReserveEffectInput): Promise<EffectReservation> {
    const count = (this.reservations.get(input.idempotencyKey) ?? 0) + 1;
    this.reservations.set(input.idempotencyKey, count);

    const existing = this.effects.get(input.idempotencyKey);
    if (existing) {
      return { reserved: false, effect: existing };
    }

    const record: EffectRecord = {
      id: randomUUID(),
      proposalId: input.proposalId,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      executor: input.executor,
      effectId: input.effectId,
      status: "pending",
      verified: false,
      observedState: null,
      evidence: [],
      durationMs: 0,
      errorCode: null,
      createdAt: "2026-11-21T12:00:00.000Z",
      appliedAt: null,
    };

    this.effects.set(input.idempotencyKey, record);
    return { reserved: true, effect: record };
  }

  async completeEffect(effectId: string, outcome: EffectOutcome): Promise<EffectRecord> {
    const record = [...this.effects.values()].find((effect) => effect.id === effectId);
    if (!record) {
      throw new Error(`unknown effect: ${effectId}`);
    }

    record.status = outcome.status;
    record.verified = outcome.verified;
    record.observedState = outcome.observedState;
    record.evidence = outcome.evidence;
    record.durationMs = outcome.durationMs;
    record.errorCode = outcome.errorCode;
    record.appliedAt = outcome.appliedAt;
    return record;
  }
}
