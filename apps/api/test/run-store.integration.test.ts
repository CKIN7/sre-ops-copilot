import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleRunStore } from "../src/adapters/run-store.js";

const DATABASE_URL = process.env.DATABASE_URL;

// En CI hay Postgres con migraciones aplicadas; en local se salta sin DATABASE_URL.
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration("DrizzleRunStore (Postgres real)", () => {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const slug = `it-${randomUUID().slice(0, 8)}`;

  let pool: Pool;
  let store: DrizzleRunStore;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }

    pool = new Pool({ connectionString: DATABASE_URL });
    store = new DrizzleRunStore(drizzle(pool));

    await pool.query(
      "insert into tenants (id, slug, name) values ($1, $2, $3)",
      [tenantId, slug, `Integration ${slug}`],
    );
    await pool.query(
      "insert into users (id, tenant_id, email, display_name) values ($1, $2, $3, $4)",
      [userId, tenantId, `it-${slug}@shop.test`, "Integration user"],
    );
    await pool.query(
      `insert into agents (id, tenant_id, name, model, prompt_version, allowed_tools)
       values ($1, $2, $3, $4, $5, $6::text[])`,
      [agentId, tenantId, `it-agent-${slug}`, "mock", "m2-v0", ["list_services"]],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("delete from tenants where id = $1", [tenantId]);
      await pool.end();
    }
  });

  it("persiste el run, los steps y la tool call en orden", async () => {
    const run = await store.createRun({
      tenantId,
      agentId,
      trigger: "cli",
      goal: "integration: investiga checkout",
    });

    expect(run).toMatchObject({
      tenantId,
      agentId,
      status: "queued",
      trigger: "cli",
    });
    expect(run.startedAt).toBeNull();

    const startedAt = new Date().toISOString();
    await store.markRunRunning(run.id, startedAt);

    const modelStep = await store.appendStep({
      runId: run.id,
      idx: 0,
      kind: "model",
      model: "mock",
      promptVersion: "m2-v0",
      latencyMs: 3,
      costCents: 0,
      payloadRef: null,
    });

    const toolStep = await store.appendStep({
      runId: run.id,
      idx: 1,
      kind: "tool",
      model: null,
      promptVersion: null,
      latencyMs: 0,
      costCents: 0,
      payloadRef: null,
    });

    const call = await store.appendToolCall({
      stepId: toolStep.id,
      tool: "list_services",
      argsRedacted: { note: "[redacted:email]" },
      status: "pending",
      idempotencyKey: null,
    });

    await store.completeToolCall({
      toolCallId: call.id,
      status: "ok",
      resultHash: "hash",
      errorCode: null,
      finishedAt: new Date().toISOString(),
    });

    const endedAt = new Date().toISOString();
    await store.finishRun(run.id, {
      status: "succeeded",
      endedAt,
      errorCode: null,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    });

    const timeline = await store.getTimeline(run.id, tenantId);
    expect(timeline).not.toBeNull();
    expect(timeline?.run).toMatchObject({
      id: run.id,
      status: "succeeded",
      startedAt,
      endedAt,
    });
    expect(timeline?.steps.map((step) => step.idx)).toEqual([0, 1]);
    expect(timeline?.steps[0]?.id).toBe(modelStep.id);
    expect(timeline?.steps[1]?.id).toBe(toolStep.id);
    expect(timeline?.steps[1]?.toolCalls).toHaveLength(1);
    expect(timeline?.steps[1]?.toolCalls[0]).toMatchObject({
      tool: "list_services",
      status: "ok",
      resultHash: "hash",
      argsRedacted: { note: "[redacted:email]" },
    });
  });

  it("no expone el timeline a otro tenant", async () => {
    const run = await store.createRun({
      tenantId,
      agentId,
      trigger: "api",
      goal: "integration: aislamiento por tenant",
    });

    const timeline = await store.getTimeline(run.id, randomUUID());
    expect(timeline).toBeNull();
  });

  it("trata un run inexistente como null", async () => {
    const timeline = await store.getTimeline(randomUUID(), tenantId);
    expect(timeline).toBeNull();
  });
});