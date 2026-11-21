import { createHash } from "node:crypto";

import type {
  BudgetDecision,
  BudgetLimits,
  BudgetPort,
  BudgetReservation,
  BudgetSettlement,
  BudgetSnapshot,
  BudgetUsage,
  ReserveBudgetInput,
  SettleBudgetInput,
} from "@beacon/core/ports/budget";
import { AppError } from "@beacon/core/errors/app-error";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "./db.js";
import { budgetReservations, usageLedger } from "./schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ReservationRow = typeof budgetReservations.$inferSelect;

const DEFAULT_RESERVATION_TTL_MS = 5 * 60_000;

export interface DrizzleBudgetOptions {
  /**
   * Vida maxima de una reserva viva. Si un proceso muere entre reservar y liquidar,
   * la siguiente reserva del tenant la cierra con uso cero. Debe superar el peor
   * caso de una tool call; si no, una llamada lenta podria perder su liquidacion.
   */
  reservationTtlMs?: number;
  now?: () => number;
}

/**
 * Implementacion Postgres del puerto `BudgetPort` (ADR-013).
 *
 * **Atomicidad:** la comprobacion del limite y el insert ocurren en la misma
 * transaccion, bajo un `pg_advisory_xact_lock` por tenant. Dos runs concurrentes
 * del mismo tenant se serializan en esta seccion critica: uno ve el total que dejo
 * el otro y no se puede pasar el limite. El lock es por tenant porque el limite de
 * tenant es el agregado; el de run se comprueba dentro de la misma transaccion.
 *
 * **Idempotencia:** `(tenant_id, idempotency_key)` es unica. Repetir una reserva
 * devuelve la guardada. La liquidacion tambien es idempotente: una reserva ya
 * liquidada no inserta otra fila en `usage_ledger` (la unicidad de `reservation_id`
 * lo impide).
 *
 * **Reservas huerfanas:** una reserva viva caduca. Antes de calcular el total, la
 * misma transaccion cierra las caducadas con uso cero. Asi un proceso que muere no
 * deja presupuesto retenido para siempre.
 */
export class DrizzleBudget implements BudgetPort {
  readonly #db: Database;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(db: Database, options: DrizzleBudgetOptions = {}) {
    this.#db = db;
    this.#ttlMs = options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  async reserve(input: ReserveBudgetInput): Promise<BudgetDecision> {
    const now = this.#now();
    const estimate = nonNegative(input.estimate);

    return this.#db.transaction(async (tx) => {
      await lockTenant(tx, input.tenantId);
      await sweepExpired(tx, input.tenantId, new Date(now));

      const [existing] = await tx
        .select()
        .from(budgetReservations)
        .where(
          and(
            eq(budgetReservations.tenantId, input.tenantId),
            eq(budgetReservations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      if (existing) {
        return {
          allowed: true,
          reservation: toReservation(existing),
          replayed: true,
        };
      }

      const runUsage = input.runId
        ? await activeUsage(tx, input.tenantId, input.runId)
        : null;
      const tenantUsage = await activeUsage(tx, input.tenantId, null);

      const denial =
        checkLimits("run", runUsage, input.limits.perRun, estimate) ??
        checkLimits("tenant", tenantUsage, input.limits.perTenant, estimate);
      if (denial) {
        return denial;
      }

      const [row] = await tx
        .insert(budgetReservations)
        .values({
          tenantId: input.tenantId,
          runId: input.runId,
          idempotencyKey: input.idempotencyKey,
          status: "reserved",
          reservedTokensIn: estimate.tokensIn,
          reservedTokensOut: estimate.tokensOut,
          reservedCostCents: estimate.costCents,
          reservedWallMs: estimate.wallMs,
          limits: input.limits,
          expiresAt: new Date(now + this.#ttlMs),
        })
        .returning();

      if (!row) {
        throw new AppError("internal", "insert budget reservation returned no row");
      }

      return {
        allowed: true,
        reservation: toReservation(row),
        replayed: false,
      };
    });
  }

  async settle(input: SettleBudgetInput): Promise<BudgetSettlement> {
    const usage = nonNegative(input.usage);
    const settledAt = new Date(this.#now());

    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.id, input.reservationId))
        .limit(1)
        .for("update");

      if (!row) {
        throw new AppError("not_found", "budget reservation not found", {
          statusCode: 404,
        });
      }

      if (row.status === "settled") {
        return { reservation: toReservation(row), replayed: true };
      }

      const [updated] = await tx
        .update(budgetReservations)
        .set({
          status: "settled",
          usedTokensIn: usage.tokensIn,
          usedTokensOut: usage.tokensOut,
          usedCostCents: usage.costCents,
          usedWallMs: usage.wallMs,
          settledAt,
        })
        .where(eq(budgetReservations.id, row.id))
        .returning();

      if (!updated) {
        throw new AppError("internal", "settle budget returned no row");
      }

      await tx
        .insert(usageLedger)
        .values({
          tenantId: updated.tenantId,
          runId: updated.runId,
          reservationId: updated.id,
          kind: input.kind ?? "tool_call",
          tool: input.tool ?? null,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costCents: usage.costCents,
          wallMs: usage.wallMs,
        })
        .onConflictDoNothing({ target: usageLedger.reservationId });

      return { reservation: toReservation(updated), replayed: false };
    });
  }

  async release(reservationId: string): Promise<BudgetSettlement> {
    return this.settle({
      reservationId,
      usage: { tokensIn: 0, tokensOut: 0, costCents: 0, wallMs: 0 },
    });
  }

  async snapshot(tenantId: string, runId: string | null): Promise<BudgetSnapshot> {
    return this.#db.transaction(async (tx) => {
      const tenantUsage = await activeUsage(tx, tenantId, null);
      const runUsage = runId ? await activeUsage(tx, tenantId, runId) : EMPTY;
      const open = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(budgetReservations)
        .where(
          and(
            eq(budgetReservations.tenantId, tenantId),
            eq(budgetReservations.status, "reserved"),
          ),
        );

      return {
        tenantId,
        runId,
        reserved: runId ? runUsage.reserved : tenantUsage.reserved,
        settled: runId ? runUsage.settled : tenantUsage.settled,
        openReservations: open[0]?.count ?? 0,
      };
    });
  }
}

interface UsageTotal {
  reserved: BudgetUsage;
  settled: BudgetUsage;
}

const EMPTY_TOTAL: UsageTotal = {
  reserved: { tokensIn: 0, tokensOut: 0, costCents: 0, wallMs: 0 },
  settled: { tokensIn: 0, tokensOut: 0, costCents: 0, wallMs: 0 },
};

const EMPTY = EMPTY_TOTAL;

/**
 * Suma lo que ya esta comprometido. Una reserva viva cuenta por su estimacion; una
 * liquidada, por su uso. La diferencia entre ambas se libera al liquidar.
 */
async function activeUsage(
  tx: Tx,
  tenantId: string,
  runId: string | null,
): Promise<UsageTotal> {
  const runFilter = runId ? sql`and run_id = ${runId}` : sql``;
  const rows = await tx.execute<{
    reserved_tokens_in: number;
    reserved_tokens_out: number;
    reserved_cost_cents: number;
    reserved_wall_ms: number;
    used_tokens_in: number;
    used_tokens_out: number;
    used_cost_cents: number;
    used_wall_ms: number;
  }>(sql`
    select
      coalesce(sum(case when status = 'reserved' then reserved_tokens_in else 0 end), 0)::int as reserved_tokens_in,
      coalesce(sum(case when status = 'reserved' then reserved_tokens_out else 0 end), 0)::int as reserved_tokens_out,
      coalesce(sum(case when status = 'reserved' then reserved_cost_cents else 0 end), 0)::int as reserved_cost_cents,
      coalesce(sum(case when status = 'reserved' then reserved_wall_ms else 0 end), 0)::int as reserved_wall_ms,
      coalesce(sum(case when status = 'settled' then used_tokens_in else 0 end), 0)::int as used_tokens_in,
      coalesce(sum(case when status = 'settled' then used_tokens_out else 0 end), 0)::int as used_tokens_out,
      coalesce(sum(case when status = 'settled' then used_cost_cents else 0 end), 0)::int as used_cost_cents,
      coalesce(sum(case when status = 'settled' then used_wall_ms else 0 end), 0)::int as used_wall_ms
    from budget_reservations
    where tenant_id = ${tenantId} ${runFilter}
  `);

  const row = rows.rows[0];
  if (!row) {
    return EMPTY_TOTAL;
  }

  return {
    reserved: {
      tokensIn: row.reserved_tokens_in,
      tokensOut: row.reserved_tokens_out,
      costCents: row.reserved_cost_cents,
      wallMs: row.reserved_wall_ms,
    },
    settled: {
      tokensIn: row.used_tokens_in,
      tokensOut: row.used_tokens_out,
      costCents: row.used_cost_cents,
      wallMs: row.used_wall_ms,
    },
  };
}

function checkLimits(
  scope: "run" | "tenant",
  usage: UsageTotal | null,
  limits: BudgetUsage,
  requested: BudgetUsage,
): BudgetDecision | null {
  if (!usage) {
    return null;
  }

  const dimensions: Array<keyof BudgetUsage> = [
    "tokensIn",
    "tokensOut",
    "costCents",
    "wallMs",
  ];

  for (const dimension of dimensions) {
    const observed = usage.reserved[dimension] + usage.settled[dimension];
    const limit = limits[dimension];
    if (observed + requested[dimension] > limit) {
      return {
        allowed: false,
        reason: "budget_exceeded",
        dimension,
        scope,
        limit,
        observed,
        requested: requested[dimension],
      };
    }
  }

  return null;
}

/** Lock por tenant: el limite agregado se calcula y se escribe sin carrera. */
async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  const key = createHash("sha256")
    .update(`budget:${tenantId}`, "utf8")
    .digest()
    .readUInt32BE(0) & 0x7fffffff;
  await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
}

/**
 * Cierra reservas caducadas con uso cero. No escribe en `usage_ledger`: no hubo
 * liquidacion real, solo se libera la retencion. La fila queda como evidencia de la
 * reserva que se abrio y no se uso.
 */
async function sweepExpired(tx: Tx, tenantId: string, now: Date): Promise<void> {
  await tx
    .update(budgetReservations)
    .set({
      status: "settled",
      usedTokensIn: 0,
      usedTokensOut: 0,
      usedCostCents: 0,
      usedWallMs: 0,
      settledAt: now,
    })
    .where(
      and(
        eq(budgetReservations.tenantId, tenantId),
        eq(budgetReservations.status, "reserved"),
        sql`${budgetReservations.expiresAt} <= ${now}`,
      ),
    );
}

function toReservation(row: ReservationRow): BudgetReservation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    reserved: {
      tokensIn: row.reservedTokensIn,
      tokensOut: row.reservedTokensOut,
      costCents: row.reservedCostCents,
      wallMs: row.reservedWallMs,
    },
    used:
      row.status === "settled"
        ? {
            tokensIn: row.usedTokensIn ?? 0,
            tokensOut: row.usedTokensOut ?? 0,
            costCents: row.usedCostCents ?? 0,
            wallMs: row.usedWallMs ?? 0,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
  };
}

function nonNegative(usage: BudgetUsage): BudgetUsage {
  return {
    tokensIn: Math.max(0, Math.trunc(usage.tokensIn)),
    tokensOut: Math.max(0, Math.trunc(usage.tokensOut)),
    costCents: Math.max(0, Math.trunc(usage.costCents)),
    wallMs: Math.max(0, Math.trunc(usage.wallMs)),
  };
}

/** Limites por defecto de un agente sin presupuesto propio declarado. */
export function budgetLimitsFor(
  budgetCents: number,
  overrides: {
    perRun?: Partial<BudgetUsage>;
    perTenant?: Partial<BudgetUsage>;
  } = {},
): BudgetLimits {
  const perRun: BudgetUsage = {
    tokensIn: 200_000,
    tokensOut: 50_000,
    wallMs: 90_000,
    ...overrides.perRun,
    costCents: budgetCents > 0 ? budgetCents : 10,
  };

  return {
    perRun,
    perTenant: {
      tokensIn: 5_000_000,
      tokensOut: 1_000_000,
      costCents: 10_000,
      wallMs: 3_600_000,
      ...overrides.perTenant,
    },
  };
}
