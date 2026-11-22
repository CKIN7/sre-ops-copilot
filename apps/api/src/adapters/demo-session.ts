import { createHash } from "node:crypto";

import { AppError } from "@beacon/core/errors/app-error";
import type {
  ChargeDemoSessionInput,
  DemoSessionDecision,
  DemoSessionState,
  DemoSessionStats,
  DemoSessionStore,
  OpenDemoSessionInput,
  RecordDemoFailureInput,
  TouchDemoSessionInput,
} from "@beacon/core/ports/demo-session";
import { eq, gte, lt, sql } from "drizzle-orm";

import type { Database } from "./db.js";
import { demoBreaker, demoSessions } from "./schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type SessionRow = typeof demoSessions.$inferSelect;
type BreakerRow = typeof demoBreaker.$inferSelect;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Inicio del dia UTC: el techo es un presupuesto diario, no una ventana movil. */
function startOfDay(now: number): Date {
  const date = new Date(now);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

async function lock(tx: Tx, key: string): Promise<void> {
  const digest = createHash("sha256").update(key, "utf8").digest();
  const value = digest.readUInt32BE(0) & 0x7fffffff;
  await tx.execute(sql`select pg_advisory_xact_lock(${value}::bigint)`);
}

/**
 * Implementacion Postgres del estado de la demo (migracion 0009, plan §4.11).
 *
 * Todo ocurre en una transaccion con lock por sesion (o por dia para el techo
 * global): el gasto, los steps y los fallos no se pierden entre replicas y no hay
 * un contador en memoria que se pueda desincronizar. La IP se persiste hasheada.
 */
export class DrizzleDemoSessionStore implements DemoSessionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async open(input: OpenDemoSessionInput): Promise<DemoSessionDecision> {
    const now = new Date(input.now);
    const expiresAt = new Date(input.now + input.ttlMs);
    const ipHash = sha256(input.ip);

    return this.#db.transaction(async (tx) => {
      await lock(tx, `demo-day:${startOfDay(input.now).toISOString()}`);
      // Limpieza perezosa: una sesion caducada no cuenta para el techo del dia.
      await tx.delete(demoSessions).where(lt(demoSessions.expiresAt, now));

      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(demoSessions)
        .where(gte(demoSessions.createdAt, startOfDay(input.now)));
      const sessionsToday = countRows[0]?.count ?? 0;

      if (sessionsToday >= input.dailyLimit) {
        await setBreaker(tx, now, true);
        return {
          allowed: false,
          reason: "daily_cap",
          state: null,
          limit: input.dailyLimit,
          observed: sessionsToday,
        };
      }

      const existing = await tx
        .select()
        .from(demoSessions)
        .where(eq(demoSessions.sessionId, input.sessionId))
        .limit(1);

      // Una sesion caducada no se resucita con el presupuesto de antes: se trata
      // como una sesion nueva (el TTL es parte del contrato de la demo).
      const live = existing[0] && existing[0].expiresAt.getTime() > input.now
        ? existing[0]
        : null;
      if (existing[0] && !live) {
        await tx.delete(demoSessions).where(eq(demoSessions.sessionId, input.sessionId));
      }

      await tx
        .insert(demoSessions)
        .values({
          sessionId: input.sessionId,
          ipHash,
          createdAt: now,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: demoSessions.sessionId,
          set: { ipHash, expiresAt },
        });

      const breaker = await readBreaker(tx);
      const row =
        live ??
        ({
          sessionId: input.sessionId,
          ipHash,
          createdAt: now,
          expiresAt,
          spentCents: 0,
          steps: 0,
        } satisfies SessionRow);

      return {
        allowed: true,
        reason: null,
        state: toState(row, breaker, sessionsToday + (live ? 0 : 1), input.dailyLimit),
        limit: null,
        observed: null,
      };
    });
  }

  async touch(input: TouchDemoSessionInput): Promise<DemoSessionDecision> {
    const expiresAt = new Date(input.now + input.ttlMs);
    const ipHash = sha256(input.ip);

    return this.#db.transaction(async (tx) => {
      await lock(tx, `demo-session:${input.sessionId}`);
      const [row] = await tx
        .select()
        .from(demoSessions)
        .where(eq(demoSessions.sessionId, input.sessionId))
        .limit(1)
        .for("update");

      if (!row || row.expiresAt.getTime() <= input.now) {
        return {
          allowed: false,
          reason: "session_expired",
          state: null,
          limit: null,
          observed: null,
        };
      }

      await tx
        .update(demoSessions)
        .set({
          ipHash,
          expiresAt: row.expiresAt > expiresAt ? row.expiresAt : expiresAt,
        })
        .where(eq(demoSessions.sessionId, input.sessionId));

      const breaker = await readBreaker(tx);
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(demoSessions)
        .where(gte(demoSessions.createdAt, startOfDay(input.now)));

      return {
        allowed: true,
        reason: null,
        state: toState(row, breaker, countRows[0]?.count ?? 0, input.dailyLimit),
        limit: null,
        observed: null,
      };
    });
  }

  async charge(input: ChargeDemoSessionInput): Promise<DemoSessionDecision> {
    return this.#db.transaction(async (tx) => {
      await lock(tx, `demo-session:${input.sessionId}`);
      const [row] = await tx
        .select()
        .from(demoSessions)
        .where(eq(demoSessions.sessionId, input.sessionId))
        .limit(1)
        .for("update");

      if (!row || row.expiresAt.getTime() <= input.now) {
        return {
          allowed: false,
          reason: "session_expired",
          state: null,
          limit: null,
          observed: null,
        };
      }

      const nextSteps = row.steps + 1;
      const nextSpent = row.spentCents + Math.max(0, input.costCents);
      const breaker = await readBreaker(tx);

      if (nextSteps > input.maxSteps) {
        return {
          allowed: false,
          reason: "session_budget",
          state: toState(row, breaker, 0, 0),
          limit: input.maxSteps,
          observed: row.steps,
        };
      }
      if (nextSpent > input.maxCostCents) {
        return {
          allowed: false,
          reason: "session_budget",
          state: toState(row, breaker, 0, 0),
          limit: input.maxCostCents,
          observed: row.spentCents,
        };
      }

      const [updated] = await tx
        .update(demoSessions)
        .set({
          steps: nextSteps,
          spentCents: nextSpent,
          expiresAt: new Date(
            Math.max(row.expiresAt.getTime(), input.now + input.ttlMs),
          ),
        })
        .where(eq(demoSessions.sessionId, input.sessionId))
        .returning();

      if (!updated) {
        throw new AppError("internal", "demo charge returned no row");
      }

      return {
        allowed: true,
        reason: null,
        state: toState(updated, breaker, 0, 0),
        limit: null,
        observed: null,
      };
    });
  }

  async recordFailure(input: RecordDemoFailureInput): Promise<DemoSessionState> {
    const now = new Date(input.now);

    return this.#db.transaction(async (tx) => {
      await lock(tx, "demo-breaker");
      const current = await readBreaker(tx);
      const failures = current.failures + 1;
      const replayOnly = current.replayOnly || failures >= input.threshold;
      await setBreaker(tx, now, replayOnly, failures);

      const [row] = await tx
        .select()
        .from(demoSessions)
        .where(eq(demoSessions.sessionId, input.sessionId))
        .limit(1);

      return toState(
        row ?? {
          sessionId: input.sessionId,
          ipHash: "",
          createdAt: now,
          expiresAt: now,
          spentCents: 0,
          steps: 0,
        },
        { replayOnly, failures },
        0,
        0,
      );
    });
  }

  async setReplayOnly(value: boolean, now: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await lock(tx, "demo-breaker");
      const current = await readBreaker(tx);
      await setBreaker(tx, new Date(now), value, current.failures);
    });
  }

  async isReplayOnly(): Promise<boolean> {
    const [row] = await this.#db.select().from(demoBreaker).limit(1);
    return row?.replayOnly ?? false;
  }

  async stats(now: number): Promise<DemoSessionStats> {
    const countRows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(demoSessions)
      .where(gte(demoSessions.createdAt, startOfDay(now)));
    const breaker = await readBreaker(this.#db);
    return {
      sessionsToday: countRows[0]?.count ?? 0,
      dailyLimit: null,
      replayOnly: breaker.replayOnly,
      failures: breaker.failures,
    };
  }

  async reset(): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await lock(tx, "demo-breaker");
      await tx.delete(demoSessions);
      await setBreaker(tx, new Date(), false, 0);
    });
  }
}

async function readBreaker(tx: Tx | Database): Promise<BreakerRow> {
  const [row] = await tx.select().from(demoBreaker).limit(1);
  return (
    row ?? {
      singleton: true,
      replayOnly: false,
      failures: 0,
      updatedAt: new Date(0),
    }
  );
}

async function setBreaker(
  tx: Tx,
  now: Date,
  replayOnly: boolean,
  failures?: number,
): Promise<void> {
  await tx
    .insert(demoBreaker)
    .values({
      singleton: true,
      replayOnly,
      failures: failures ?? 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: demoBreaker.singleton,
      set: {
        replayOnly,
        ...(failures === undefined ? {} : { failures }),
        updatedAt: now,
      },
    });
}

function toState(
  row: SessionRow,
  breaker: Pick<BreakerRow, "replayOnly" | "failures">,
  sessionsToday: number,
  dailyLimit: number,
): DemoSessionState {
  return {
    sessionId: row.sessionId,
    ipHash: row.ipHash,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    spentCents: row.spentCents,
    steps: row.steps,
    sessionsToday,
    dailyLimit,
    failures: breaker.failures,
    replayOnly: breaker.replayOnly,
  };
}
