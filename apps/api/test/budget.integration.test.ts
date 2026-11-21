import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BudgetUsage } from "@beacon/core/ports/budget";

import { DrizzleBudget } from "../src/adapters/budget.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

function usage(costCents: number): BudgetUsage {
  return { tokensIn: 0, tokensOut: 0, costCents, wallMs: 0 };
}

/**
 * DoD de M6: "presupuesto correcto con 20 runs paralelos".
 *
 * Mismo tenant, mismo limite, 20 reservas lanzadas a la vez. La transaccion con
 * lock por tenant debe dejar pasar exactamente las que caben (10 de 1 centimo con
 * un techo de 10) y rechazar el resto. Al liquidar, el ledger suma exactamente 10,
 * no queda ninguna reserva viva y repetir una clave no cobra dos veces.
 */
describeIntegration("DrizzleBudget (20 runs paralelos, Postgres real)", () => {
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const slug = `budget-${randomUUID().slice(0, 8)}`;
  const runIds = Array.from({ length: 20 }, () => randomUUID());

  let pool: Pool;
  let budget: DrizzleBudget;

  const limits = {
    perRun: { tokensIn: 1_000, tokensOut: 1_000, costCents: 5, wallMs: 90_000 },
    perTenant: { tokensIn: 1_000_000, tokensOut: 1_000_000, costCents: 10, wallMs: 3_600_000 },
  };

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }

    pool = new Pool({ connectionString: DATABASE_URL });
    budget = new DrizzleBudget(drizzle(pool), { reservationTtlMs: 60_000 });

    await pool.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
      tenantId,
      slug,
      `Budget ${slug}`,
    ]);
    await pool.query(
      `insert into agents (id, tenant_id, name, model, prompt_version, allowed_tools, budget_cents)
       values ($1, $2, $3, 'mock', 'm2-v0', $4::text[], 5)`,
      [agentId, tenantId, `budget-agent-${slug}`, ["list_services"]],
    );

    for (const [index, runId] of runIds.entries()) {
      await pool.query(
        `insert into runs (id, tenant_id, agent_id, status, trigger, goal)
         values ($1, $2, $3, 'running', 'cli', $4)`,
        [runId, tenantId, agentId, `budget concurrency ${index}`],
      );
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("delete from tenants where id = $1", [tenantId]);
      await pool.end();
    }
  });

  it("no sobrepasa el limite del tenant ni deja reservas huerfanas", async () => {
    const decisions = await Promise.all(
      runIds.map((runId, index) =>
        budget.reserve({
          tenantId,
          runId,
          idempotencyKey: `run:${runId}:step:1:tool:list_services:${index}`,
          estimate: usage(1),
          limits,
        }),
      ),
    );

    const allowed = decisions.filter((decision) => decision.allowed);
    const denied = decisions.filter((decision) => !decision.allowed);

    expect(allowed).toHaveLength(10);
    expect(denied).toHaveLength(10);
    for (const decision of denied) {
      expect(decision).toMatchObject({
        reason: "budget_exceeded",
        dimension: "costCents",
        scope: "tenant",
        limit: 10,
      });
    }

    for (const decision of allowed) {
      if (decision.allowed) {
        await budget.settle({
          reservationId: decision.reservation.id,
          usage: usage(1),
          kind: "tool_call",
          tool: "list_services",
        });
      }
    }

    const snapshot = await budget.snapshot(tenantId, null);
    expect(snapshot.openReservations).toBe(0);
    expect(snapshot.settled.costCents).toBe(10);

    const reservations = await pool.query<{ status: string; total: number }>(
      `select status, count(*)::int as total
       from budget_reservations
       where tenant_id = $1
       group by status
       order by status`,
      [tenantId],
    );
    expect(reservations.rows).toEqual([{ status: "settled", total: 10 }]);

    const ledger = await pool.query<{ rows: number; cost: number }>(
      `select count(*)::int as rows, coalesce(sum(cost_cents), 0)::int as cost
       from usage_ledger
       where tenant_id = $1`,
      [tenantId],
    );
    expect(ledger.rows[0]).toEqual({ rows: 10, cost: 10 });

    const firstRunId = runIds[0];
    if (!firstRunId) {
      throw new Error("expected at least one run");
    }

    const replay = await budget.reserve({
      tenantId,
      runId: firstRunId,
      idempotencyKey: "run:replay-does-not-matter",
      estimate: usage(1),
      limits,
    });
    expect(replay.allowed).toBe(false);

    const firstAllowed = allowed[0];
    if (!firstAllowed?.allowed) {
      throw new Error("expected at least one allowed reservation");
    }
    const replayExisting = await budget.reserve({
      tenantId,
      runId: firstRunId,
      idempotencyKey: firstAllowed.reservation.idempotencyKey,
      estimate: usage(1),
      limits,
    });
    expect(replayExisting).toMatchObject({ allowed: true, replayed: true });

    const afterReplay = await budget.snapshot(tenantId, null);
    expect(afterReplay.settled.costCents).toBe(10);
  }, 30_000);

  it("usage_ledger es append-only", async () => {
    await expect(
      pool.query("update usage_ledger set cost_cents = 0 where tenant_id = $1", [
        tenantId,
      ]),
    ).rejects.toThrow(/append-only/);

    await expect(
      pool.query("delete from usage_ledger where tenant_id = $1", [tenantId]),
    ).rejects.toThrow(/append-only/);
  });
});
