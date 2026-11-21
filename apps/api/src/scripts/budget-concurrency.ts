import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { DrizzleBudget } from "../adapters/budget.js";

/**
 * Prueba reproducible del DoD de M6: 20 runs en paralelo, mismo tenant y mismo
 * limite. No usa el modelo ni las tools: ejercita el presupuesto real contra
 * Postgres, que es donde vive la reserva atomica.
 *
 * Uso: `pnpm budget:concurrency` (necesita DATABASE_URL y migraciones aplicadas).
 * Sale con 1 si el resultado no es exactamente el esperado.
 */
const COUNT = 20;
const TENANT_LIMIT_CENTS = 10;
const RESERVE_CENTS = 1;
const EXPECTED_ALLOWED = TENANT_LIMIT_CENTS / RESERVE_CENTS;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL es obligatorio para budget:concurrency");
  }

  const pool = new Pool({ connectionString: databaseUrl, application_name: "beacon-budget" });
  const budget = new DrizzleBudget(drizzle(pool), { reservationTtlMs: 60_000 });
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const slug = `budget-script-${randomUUID().slice(0, 8)}`;
  const runIds = Array.from({ length: COUNT }, () => randomUUID());

  try {
    await pool.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
      tenantId,
      slug,
      `Budget script ${slug}`,
    ]);
    await pool.query(
      `insert into agents (id, tenant_id, name, model, prompt_version, allowed_tools, budget_cents)
       values ($1, $2, $3, 'mock', 'm2-v0', $4::text[], $5)`,
      [agentId, tenantId, `budget-script-${slug}`, ["list_services"], TENANT_LIMIT_CENTS],
    );
    for (const [index, runId] of runIds.entries()) {
      await pool.query(
        `insert into runs (id, tenant_id, agent_id, status, trigger, goal)
         values ($1, $2, $3, 'running', 'cli', $4)`,
        [runId, tenantId, agentId, `budget concurrency ${index}`],
      );
    }

    const limits = {
      perRun: { tokensIn: 1_000, tokensOut: 1_000, costCents: 5, wallMs: 90_000 },
      perTenant: {
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        costCents: TENANT_LIMIT_CENTS,
        wallMs: 3_600_000,
      },
    };

    const startedAt = performance.now();
    const decisions = await Promise.all(
      runIds.map((runId, index) =>
        budget.reserve({
          tenantId,
          runId,
          idempotencyKey: `run:${runId}:step:1:tool:list_services:${index}`,
          estimate: { tokensIn: 0, tokensOut: 0, costCents: RESERVE_CENTS, wallMs: 0 },
          limits,
        }),
      ),
    );
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));

    const allowed = decisions.filter((decision) => decision.allowed);
    for (const decision of allowed) {
      if (decision.allowed) {
        await budget.settle({
          reservationId: decision.reservation.id,
          usage: { tokensIn: 0, tokensOut: 0, costCents: RESERVE_CENTS, wallMs: 1 },
          kind: "tool_call",
          tool: "list_services",
        });
      }
    }

    const snapshot = await budget.snapshot(tenantId, null);
    const ledger = await pool.query<{ rows: number; cost: number }>(
      `select count(*)::int as rows, coalesce(sum(cost_cents), 0)::int as cost
       from usage_ledger where tenant_id = $1`,
      [tenantId],
    );
    const open = await pool.query<{ total: number }>(
      `select count(*)::int as total from budget_reservations
       where tenant_id = $1 and status = 'reserved'`,
      [tenantId],
    );

    const result = {
      runs: COUNT,
      concurrency: COUNT,
      tenantLimitCents: TENANT_LIMIT_CENTS,
      reserveCents: RESERVE_CENTS,
      allowed: allowed.length,
      denied: decisions.length - allowed.length,
      settledCostCents: snapshot.settled.costCents,
      openReservations: open.rows[0]?.total ?? -1,
      ledgerRows: ledger.rows[0]?.rows ?? -1,
      ledgerCostCents: ledger.rows[0]?.cost ?? -1,
      elapsedMs,
      budgetRespected:
        allowed.length === EXPECTED_ALLOWED &&
        snapshot.settled.costCents <= TENANT_LIMIT_CENTS &&
        (open.rows[0]?.total ?? 1) === 0 &&
        (ledger.rows[0]?.cost ?? 0) <= TENANT_LIMIT_CENTS,
    };

    console.log(JSON.stringify(result, null, 2));

    if (!result.budgetRespected) {
      process.exitCode = 1;
    }
  } finally {
    await pool.query("delete from tenants where id = $1", [tenantId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
