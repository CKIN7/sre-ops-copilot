import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleRateLimiter } from "../src/adapters/rate-limiter.js";

const DATABASE_URL = process.env.DATABASE_URL;

// En CI hay Postgres con migraciones aplicadas; en local se salta sin DATABASE_URL.
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration("DrizzleRateLimiter (Postgres real)", () => {
  const tenantId = randomUUID();
  const slug = `rate-${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();

  let pool: Pool;
  let limiter: DrizzleRateLimiter;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }

    pool = new Pool({ connectionString: DATABASE_URL });
    limiter = new DrizzleRateLimiter(drizzle(pool), {
      run: 3,
      tenant: 5,
      tool: 2,
      windowMs: 60_000,
    });

    await pool.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
      tenantId,
      slug,
      `Rate ${slug}`,
    ]);
    await pool.query(
      `insert into runs (id, tenant_id, agent_id, status, trigger, goal)
       select $1, $2, id, 'running', 'cli', 'integration: rate limit'
       from agents limit 1`,
      [runId, tenantId],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("delete from tenants where id = $1", [tenantId]);
      await pool.end();
    }
  });

  it("permite hasta el limite del ambito tool y despues lo rechaza", async () => {
    const first = await limiter.consume({ tenantId, runId, tool: "query_metrics" });
    expect(first.allowed).toBe(true);

    const second = await limiter.consume({ tenantId, runId, tool: "query_metrics" });
    expect(second.allowed).toBe(true);

    const third = await limiter.consume({ tenantId, runId, tool: "query_metrics" });
    expect(third.allowed).toBe(false);
    expect(third.scope).toBe("tool");
    expect(third.limit).toBe(2);
    expect(third.retryAfterMs).not.toBeNull();
  });

  it("una llamada rechazada no se cuenta: el contador no crece", async () => {
    const { rows } = await pool.query<{ count: number }>(
      "select count(*)::int as count from rate_limit_events where tenant_id = $1 and tool = $2",
      [tenantId, "query_metrics"],
    );

    expect(rows[0]?.count).toBe(2);
  });

  it("otra tool tiene su propio ambito", async () => {
    const decision = await limiter.consume({ tenantId, runId, tool: "get_deploys" });
    expect(decision.allowed).toBe(true);
  });

  it("el ambito run se agota antes que el de tool", async () => {
    // El limite de run es 3 y ya se han consumido 3 llamadas del run.
    const decision = await limiter.consume({ tenantId, runId, tool: "search_runbooks" });
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe("run");
    expect(decision.limit).toBe(3);
  });

  it("otro run del mismo tenant no hereda el contador del run", async () => {
    const otherRun = randomUUID();
    await pool.query(
      `insert into runs (id, tenant_id, agent_id, status, trigger, goal)
       select $1, $2, id, 'running', 'cli', 'integration: otro run'
       from agents limit 1`,
      [otherRun, tenantId],
    );

    const decision = await limiter.consume({ tenantId, runId: otherRun, tool: "query_metrics" });
    // El ambito tool del tenant ya esta agotado: el ambito run es el que decide.
    expect(decision.scope).toBe("tool");
  });
});
