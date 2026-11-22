import { randomUUID } from "node:crypto";

import type { AuditLog } from "@beacon/core/ports/audit-log";
import type { McpTransport } from "@beacon/gateway/transport";
import { createToolGateway } from "@beacon/gateway";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { DrizzleAuditLog } from "../adapters/audit-log.js";
import { DrizzleDemoSessionStore } from "../adapters/demo-session.js";
import { DrizzleRateLimiter } from "../adapters/rate-limiter.js";

/**
 * Smoke de la demo publica (M7): ejercita la politica del gateway contra Postgres
 * real, sin `mcp-ops` y sin ninguna escritura real.
 *
 * Comprueba: techo de steps por sesion, breaker por fallos, fallback a replay y
 * denegacion de escrituras en REPLAY_ONLY. Sale con 1 si algo no se cumple.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("demo:smoke bloqueado: falta DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool);
const store = new DrizzleDemoSessionStore(db);
const tenantId = randomUUID();
const sessionId = randomUUID();

const replayCalls: string[] = [];
const replayTransport: McpTransport = {
  async callTool(request) {
    replayCalls.push(request.name);
    return { source: "replay", tool: request.name };
  },
};
const failingTransport: McpTransport = {
  async callTool() {
    throw new Error("smoke: mcp-ops no responde");
  },
};

const audit = new DrizzleAuditLog(db) as AuditLog;
const limiter = new DrizzleRateLimiter(db, {
  run: 100,
  tenant: 100,
  tool: 100,
  session: 100,
  ip: 100,
  windowMs: 60_000,
});

try {
  await store.reset();
  await pool.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
    tenantId,
    `smoke-${tenantId.slice(0, 8)}`,
    "demo smoke",
  ]);

  const now = Date.now();
  const opened = await store.open({
    sessionId,
    ip: "203.0.113.10",
    now,
    ttlMs: 3_600_000,
    dailyLimit: 200,
  });
  assert(opened.allowed, "la sesion de smoke no se pudo abrir");

  const gateway = createToolGateway({
    transport: failingTransport,
    allowedTools: ["list_services", "propose_rollback"],
    audit,
    rateLimiter: limiter,
    actor: "agent:incident-copilot",
    proposals: {
      createProposal: async () => {
        throw new Error("smoke no debe crear propuestas");
      },
      getProposal: async () => null,
      listProposals: async () => [],
      getApproval: async () => null,
      decideApproval: async () => {
        throw new Error("smoke no debe decidir");
      },
      updateProposalStatus: async () => undefined,
    },
    demo: {
      sessions: store,
      sessionId,
      ip: "203.0.113.10",
      maxCostCents: 5,
      maxSteps: 6,
      sessionTtlMs: 3_600_000,
      dailyLimit: 200,
      failureThreshold: 1,
      replayOnly: false,
      replayTransport,
    },
  });

  const context = {
    tenantId,
    userId: randomUUID(),
    agentId: randomUUID(),
    runId: null,
    stepIdx: 0,
    demoSessionId: sessionId,
    demoIp: "203.0.113.10",
  };

  // Primer fallo: dispara el breaker. El segundo call debe caer a replay.
  let failed = false;
  try {
    await gateway.call("list_services", {}, context);
  } catch {
    failed = true;
  }
  assert(failed, "el fallo simulado de mcp-ops no se propago");
  assert(await store.isReplayOnly(), "el breaker no se activo tras el fallo");

  const replayed = await gateway.call("list_services", {}, context);
  assert(
    (replayed.result as { source?: string }).source === "replay",
    "la llamada no se sirvio desde replay",
  );
  assert(replayCalls.length === 1, "el replay no registro la llamada");

  // En REPLAY_ONLY una escritura se deniega antes de tocar el transporte.
  let writeDenied = false;
  try {
    await gateway.call(
      "propose_rollback",
      { service: "checkout", to_version: "v1.40.0", reason: "smoke" },
      context,
    );
  } catch (error) {
    writeDenied = (error as { code?: string }).code === "forbidden";
  }
  assert(writeDenied, "REPLAY_ONLY no denego la escritura");

  // El techo de steps de la sesion sigue siendo atomico y explicito.
  await store.reset();
  await store.open({ sessionId, ip: "203.0.113.10", now, ttlMs: 3_600_000, dailyLimit: 200 });
  const steps: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const charge = await store.charge({
      sessionId,
      now,
      ttlMs: 3_600_000,
      costCents: 0,
      maxCostCents: 5,
      maxSteps: 6,
    });
    steps.push(charge.allowed ? 1 : 0);
  }
  assert(steps.slice(0, 6).every((value) => value === 1), "se denego un step permitido");
  assert(steps[6] === 0, "el septimo step no se denego");

  console.log(
    JSON.stringify(
      {
        ok: true,
        replayOnly: true,
        replayCalls: replayCalls.length,
        writeDenied,
        steps: steps.join(""),
        note: "smoke in-process; no se llamo a mcp-ops ni se escribio ningun servicio",
      },
      null,
      2,
    ),
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : (code ?? String(error));
  console.error(`demo:smoke fallo: ${message}`);
  process.exitCode = 1;
} finally {
  await store.reset().catch(() => undefined);
  await pool.query("delete from tenants where id = $1", [tenantId]).catch(() => undefined);
  await pool.end();
}
