import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleDemoSessionStore } from "../src/adapters/demo-session.js";
import { DrizzleRateLimiter } from "../src/adapters/rate-limiter.js";

const DATABASE_URL = process.env.DATABASE_URL;

// En CI hay Postgres con migraciones aplicadas; en local se salta sin DATABASE_URL.
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration("demo publica contra Postgres real", () => {
  const tenantId = randomUUID();
  const slug = `demo-${randomUUID().slice(0, 8)}`;

  let pool: Pool;
  let store: DrizzleDemoSessionStore;
  let limiter: DrizzleRateLimiter;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }
    pool = new Pool({ connectionString: DATABASE_URL });
    const db = drizzle(pool);
    store = new DrizzleDemoSessionStore(db);
    limiter = new DrizzleRateLimiter(db, {
      run: 100,
      tenant: 100,
      tool: 100,
      session: 2,
      ip: 10,
      windowMs: 60_000,
    });

    await pool.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
      tenantId,
      slug,
      `Demo ${slug}`,
    ]);
    await store.reset();
  });

  afterAll(async () => {
    if (pool) {
      await store.reset();
      await pool.query("delete from tenants where id = $1", [tenantId]);
      await pool.end();
    }
  });

  it("aplica el techo diario de sesiones y dispara el breaker", async () => {
    const now = Date.now();
    const first = await store.open({
      sessionId: randomUUID(),
      ip: "203.0.113.1",
      now,
      ttlMs: 3_600_000,
      dailyLimit: 2,
    });
    const second = await store.open({
      sessionId: randomUUID(),
      ip: "203.0.113.2",
      now,
      ttlMs: 3_600_000,
      dailyLimit: 2,
    });
    const third = await store.open({
      sessionId: randomUUID(),
      ip: "203.0.113.3",
      now,
      ttlMs: 3_600_000,
      dailyLimit: 2,
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("daily_cap");
    expect(await store.isReplayOnly()).toBe(true);
  });

  it("cobra steps y coste con reserva atomica por sesion", async () => {
    await store.reset();
    const sessionId = randomUUID();
    const now = Date.now();
    await store.open({ sessionId, ip: "203.0.113.5", now, ttlMs: 3_600_000, dailyLimit: 200 });

    const one = await store.charge({
      sessionId,
      now,
      ttlMs: 3_600_000,
      costCents: 2,
      maxCostCents: 5,
      maxSteps: 2,
    });
    const two = await store.charge({
      sessionId,
      now,
      ttlMs: 3_600_000,
      costCents: 2,
      maxCostCents: 5,
      maxSteps: 2,
    });
    const three = await store.charge({
      sessionId,
      now,
      ttlMs: 3_600_000,
      costCents: 0,
      maxCostCents: 5,
      maxSteps: 2,
    });

    expect(one.allowed).toBe(true);
    expect(two.allowed).toBe(true);
    expect(three.allowed).toBe(false);
    expect(three.reason).toBe("session_budget");
    expect(three.observed).toBe(2);
  });

  it("una sesion caducada no se refresca", async () => {
    const now = Date.now();
    const sessionId = randomUUID();
    await store.open({
      sessionId,
      ip: "203.0.113.6",
      now: now - 10_000,
      ttlMs: 1_000,
      dailyLimit: 200,
    });

    const result = await store.touch({
      sessionId,
      ip: "203.0.113.6",
      now,
      ttlMs: 3_600_000,
      dailyLimit: 200,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("session_expired");
  });

  it("los fallos disparan REPLAY_ONLY y reset lo limpia", async () => {
    await store.reset();
    const sessionId = randomUUID();
    const now = Date.now();
    await store.open({ sessionId, ip: "203.0.113.7", now, ttlMs: 3_600_000, dailyLimit: 200 });

    const first = await store.recordFailure({ sessionId, now, threshold: 2 });
    expect(first.replayOnly).toBe(false);
    const second = await store.recordFailure({ sessionId, now, threshold: 2 });
    expect(second.replayOnly).toBe(true);
    expect(await store.isReplayOnly()).toBe(true);

    await store.reset();
    expect(await store.isReplayOnly()).toBe(false);
  });

  it("el rate limit por sesion reutiliza la ventana deslizante atomica", async () => {
    const sessionId = randomUUID();
    const ip = "203.0.113.8";
    const first = await limiter.consume({
      tenantId,
      runId: null,
      tool: "list_services",
      sessionId,
      ip,
    });
    const second = await limiter.consume({
      tenantId,
      runId: null,
      tool: "list_services",
      sessionId,
      ip,
    });
    const third = await limiter.consume({
      tenantId,
      runId: null,
      tool: "list_services",
      sessionId,
      ip,
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.scope).toBe("session");
  });
});
