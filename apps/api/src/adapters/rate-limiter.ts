import { createHash } from "node:crypto";

import type {
  RateLimitDecision,
  RateLimitInput,
  RateLimitPolicy,
  RateLimitScopeKind,
  RateLimiter,
} from "@beacon/core/ports/rate-limiter";
import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "./db.js";
import { rateLimitEvents } from "./schema.js";

/** Transacción de Drizzle sobre el mismo esquema: la usan las consultas del adaptador. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface ScopeWindow {
  kind: RateLimitScopeKind;
  limit: number;
  /** Clave del lock: dos llamadas con la misma clave se serializan. */
  lockKey: string;
  where: ReturnType<typeof eq>[];
}

/**
 * Implementación Drizzle del puerto `RateLimiter` (docs/plan.md §4.4, ADR-012).
 *
 * Ventana deslizante de verdad: se cuentan los eventos de la ventana, no un contador
 * que se reinicia. El estado vive en Postgres, así que el límite reparte entre réplicas
 * y sobrevive a un reinicio del proceso.
 *
 * **Atomicidad:** la comprobación y el registro ocurren en la misma transacción, bajo
 * un lock por ámbito. Sin el lock, dos réplicas podrían ver el mismo contador y pasar
 * las dos el mismo límite.
 */
export class DrizzleRateLimiter implements RateLimiter {
  readonly #db: Database;
  readonly #policy: RateLimitPolicy;

  constructor(db: Database, policy: RateLimitPolicy) {
    this.#db = db;
    this.#policy = policy;
  }

  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    const now = Date.now();
    const windowStart = new Date(now - this.#policy.windowMs);

    return this.#db.transaction(async (tx) => {
      const scopes: ScopeWindow[] = [
        {
          kind: "run",
          limit: this.#policy.run,
          lockKey: `run:${input.runId}`,
          where: [eq(rateLimitEvents.runId, input.runId)],
        },
        {
          kind: "tenant",
          limit: this.#policy.tenant,
          lockKey: `tenant:${input.tenantId}`,
          where: [eq(rateLimitEvents.tenantId, input.tenantId)],
        },
        {
          kind: "tool",
          limit: this.#policy.tool,
          lockKey: `tool:${input.tenantId}:${input.tool}`,
          where: [
            eq(rateLimitEvents.tenantId, input.tenantId),
            eq(rateLimitEvents.tool, input.tool),
          ],
        },
      ];

      // Orden global de los locks: acquisition en orden lexicografico para que dos
      // llamadas que comparten ambitos no se bloqueen mutuamente.
      const locks = scopes
        .map((scope) => ({ scope, key: lockKeyOf(scope.lockKey) }))
        .sort((left, right) => left.key - right.key);

      for (const lock of locks) {
        await tx.execute(sql`select pg_advisory_xact_lock(${lock.key}::bigint)`);
      }

      for (const scope of scopes) {
        const observed = await countInWindow(tx, scope.where, windowStart);
        if (observed.count >= scope.limit) {
          return {
            allowed: false,
            scope: scope.kind,
            limit: scope.limit,
            observed: observed.count,
            retryAfterMs: retryAfterMs(observed.oldest, now, this.#policy.windowMs),
          };
        }
      }

      await tx.insert(rateLimitEvents).values({
        tenantId: input.tenantId,
        runId: input.runId,
        tool: input.tool,
      });

      return {
        allowed: true,
        scope: null,
        limit: 0,
        observed: 0,
        retryAfterMs: null,
      };
    });
  }
}

interface WindowCount {
  count: number;
  oldest: number | null;
}

async function countInWindow(
  tx: Tx,
  where: ReturnType<typeof eq>[],
  windowStart: Date,
): Promise<WindowCount> {
  const rows = await tx
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<unknown>`min(${rateLimitEvents.createdAt})`,
    })
    .from(rateLimitEvents)
    .where(and(...where, gte(rateLimitEvents.createdAt, windowStart)));

  const row = rows[0];
  return { count: row?.count ?? 0, oldest: toEpochMs(row?.oldest) };
}

/**
 * Normaliza el valor de `min(created_at)` a milisegundos. El driver lo devuelve como
 * `Date` cuando conoce el tipo y como texto cuando no; los dos formatos se leen.
 */
function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string") {
    // "2026-11-20 17:19:00.123+00" -> "2026-11-20T17:19:00.123+00:00"
    const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Milisegundos hasta que expire el evento más viejo de la ventana. */
function retryAfterMs(oldestMs: number | null, now: number, windowMs: number): number | null {
  if (oldestMs === null) {
    return null;
  }
  const elapsed = now - oldestMs;
  return Math.max(0, windowMs - elapsed);
}

/**
 * Lock por ámbito a partir de una clave legible. El hash evita que dos claves
 * distintas colapsen en el mismo entero.
 */
function lockKeyOf(scopeKey: string): number {
  const digest = createHash("sha256").update(scopeKey, "utf8").digest();
  // 31 bits para que el valor quepa en un entero con signo de Postgres.
  return digest.readUInt32BE(0) & 0x7fffffff;
}
