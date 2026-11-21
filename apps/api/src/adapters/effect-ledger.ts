import { randomUUID } from "node:crypto";

import { AppError } from "@beacon/core/errors/app-error";
import type {
  EffectLedger,
  EffectOutcome,
  EffectRecord,
  EffectReservation,
  ReserveEffectInput,
} from "@beacon/core/ports/effect-ledger";
import { desc, eq } from "drizzle-orm";

import type { Database } from "./db.js";
import { actionEffects } from "./schema.js";

function toIso(value: Date): string;
function toIso(value: Date | null): string | null;
function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toEffect(row: typeof actionEffects.$inferSelect): EffectRecord {
  return {
    id: row.id,
    proposalId: row.proposalId,
    tenantId: row.tenantId,
    idempotencyKey: row.idempotencyKey,
    executor: row.executor,
    effectId: row.effectId,
    status: row.status,
    verified: row.verified,
    observedState: row.observedState,
    evidence: row.evidence,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    appliedAt: toIso(row.appliedAt),
  };
}

/**
 * Implementación Drizzle del puerto `EffectLedger` (ADR-004 decisión 5).
 *
 * La reserva inserta con `on conflict do nothing` sobre `idempotency_key`: si la fila
 * ya existe, `reserved` viene `false` y la escritura **no** se vuelve a ejecutar. La
 * garantía no está en el código del gateway sino en la restricción de la tabla, así
 * que sobrevive a un reinicio y a dos réplicas a la vez.
 */
export class DrizzleEffectLedger implements EffectLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async reserveEffect(input: ReserveEffectInput): Promise<EffectReservation> {
    const inserted = await this.#db
      .insert(actionEffects)
      .values({
        id: randomUUID(),
        proposalId: input.proposalId,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        executor: input.executor,
        effectId: input.effectId,
        status: "pending",
        verified: false,
        evidence: [],
        durationMs: 0,
      })
      .onConflictDoNothing({ target: actionEffects.idempotencyKey })
      .returning();

    const row = inserted[0];
    if (row) {
      return { reserved: true, effect: toEffect(row) };
    }

    const existing = await this.#db
      .select()
      .from(actionEffects)
      .where(eq(actionEffects.idempotencyKey, input.idempotencyKey))
      .limit(1);

    const found = existing[0];
    if (!found) {
      throw new AppError("internal", "action_effects insert returned no row");
    }
    return { reserved: false, effect: toEffect(found) };
  }

  async completeEffect(effectId: string, outcome: EffectOutcome): Promise<EffectRecord> {    const updated = await this.#db
      .update(actionEffects)
      .set({
        status: outcome.status,
        verified: outcome.verified,
        observedState: outcome.observedState,
        evidence: outcome.evidence,
        durationMs: outcome.durationMs,
        errorCode: outcome.errorCode,
        appliedAt: new Date(outcome.appliedAt),
      })
      .where(eq(actionEffects.id, effectId))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new AppError("internal", "action_effects update returned no row");
    }
    return toEffect(row);
  }

  async getEffectForProposal(proposalId: string): Promise<EffectRecord | null> {
    const rows = await this.#db
      .select()
      .from(actionEffects)
      .where(eq(actionEffects.proposalId, proposalId))
      .orderBy(desc(actionEffects.createdAt))
      .limit(1);

    const row = rows[0];
    return row ? toEffect(row) : null;
  }
}
