import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleAuditLog, GENESIS_HASH } from "../src/adapters/audit-log.js";

const DATABASE_URL = process.env.DATABASE_URL;

// En CI hay Postgres con migraciones aplicadas; en local se salta sin DATABASE_URL.
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration("DrizzleAuditLog (Postgres real)", () => {
  const tenantId = randomUUID();
  const slug = `audit-${randomUUID().slice(0, 8)}`;

  let pool: Pool;
  let audit: DrizzleAuditLog;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }

    pool = new Pool({ connectionString: DATABASE_URL });
    audit = new DrizzleAuditLog(drizzle(pool));

    await pool.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
      tenantId,
      slug,
      `Audit ${slug}`,
    ]);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("delete from tenants where id = $1", [tenantId]);
      await pool.end();
    }
  });

  it("encadena las entradas y verifica la cadena", async () => {
    const first = await audit.append({
      tenantId,
      actor: "agent:incident-copilot",
      action: "tool.call.allowed",
      target: "query_metrics#run-1",
      payload: { args: { service: "checkout" } },
    });
    const second = await audit.append({
      tenantId,
      actor: "agent:incident-copilot",
      action: "tool.call.result",
      target: "query_metrics#run-1",
      payload: { args: { service: "checkout" }, latency_ms: 12 },
    });

    // La cadena es global: la primera fila de una base vacía arranca en el génesis.
    const { rows: head } = await pool.query<{ count: number }>(
      "select count(*)::int as count from audit_log",
    );
    if ((head[0]?.count ?? 0) === 1) {
      expect(first.prevHash).toBe(GENESIS_HASH);
    } else {
      expect(first.prevHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);

    const verification = await audit.verify();
    expect(verification).toMatchObject({ ok: true, brokenAt: null, reason: null });
    expect(verification.entries).toBeGreaterThanOrEqual(2);
  });

  it("guarda solo huellas: el payload no está en la tabla", async () => {
    const record = await audit.append({
      tenantId,
      actor: "agent:incident-copilot",
      action: "tool.call.result",
      target: "search_logs#run-2",
      payload: { args: { service: "checkout", query: "user=oncall@shop.test" } },
    });

    const { rows } = await pool.query<{ payload_hash: string; hash: string }>(
      "select payload_hash, hash from audit_log where id = $1",
      [record.id],
    );

    expect(rows[0]?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);

    // El email redactado no aparece en la fila: solo vive dentro del hash.
    const { rows: raw } = await pool.query<{ row: string }>(
      "select row_to_json(a)::text as row from audit_log a where id = $1",
      [record.id],
    );
    expect(raw[0]?.row).not.toContain("oncall@shop.test");
    expect(raw[0]?.row).not.toContain("[redacted:email]");
  });

  it("la tabla es append-only: la base rechaza un update", async () => {
    const record = await audit.append({
      tenantId,
      actor: "agent:incident-copilot",
      action: "tool.call.denied",
      target: "search_logs#run-3",
      payload: { reason: "forbidden" },
    });

    await expect(
      pool.query("update audit_log set actor = 'otro' where id = $1", [record.id]),
    ).rejects.toThrow(/append-only/);
  });

  it("detecta una fila insertada con un hash falso", async () => {
    const before = await audit.verify();
    expect(before.ok).toBe(true);

    // Como si alguien insertara una fila sin pasar por el escritor: el `prev_hash`
    // no enlaza con la fila anterior y la cadena queda rota.
    await pool.query(
      `insert into audit_log
         (tenant_id, actor, action, target, payload_hash, prev_hash, hash, created_at)
       values ($1, 'agent:intruso', 'tool.call.allowed', 'query_metrics#run-4',
               repeat('a', 64), repeat('b', 64), repeat('c', 64), now())`,
      [tenantId],
    );

    const after = await audit.verify();
    expect(after.ok).toBe(false);
    expect(after.brokenAt).not.toBeNull();
    expect(after.reason).toBeTruthy();
  });
});
