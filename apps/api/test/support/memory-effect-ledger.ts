import { randomUUID } from "node:crypto";

import type { EffectRecord } from "@beacon/core/domain/proposals";
import type {
  EffectLedger,
  EffectOutcome,
  EffectReservation,
  ReserveEffectInput,
} from "@beacon/core/ports/effect-ledger";

/**
 * Registro de efectos en memoria para los tests de HTTP de la API.
 *
 * Reproduce la restricción que da idempotencia: una fila por clave de idempotencia.
 */
export class MemoryEffectLedger implements EffectLedger {
  readonly effects = new Map<string, EffectRecord>();

  async reserveEffect(input: ReserveEffectInput): Promise<EffectReservation> {
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

  async getEffectForProposal(proposalId: string): Promise<EffectRecord | null> {
    return [...this.effects.values()].find((effect) => effect.proposalId === proposalId) ?? null;
  }
}
