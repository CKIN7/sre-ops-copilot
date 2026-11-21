import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { SimulatedExecutor } from "@beacon/executors/simulated";
import { createToolGateway } from "@beacon/gateway";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleActionStateStore } from "../src/adapters/action-state.js";
import { DrizzleAuditLog } from "../src/adapters/audit-log.js";
import { DrizzleEffectLedger } from "../src/adapters/effect-ledger.js";
import { DrizzleProposalStore } from "../src/adapters/proposal-store.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AgentBinding, PrincipalDirectory } from "../src/application/principal-directory.js";
import { MemoryRunStore } from "./support/memory-run-store.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // Sin .env en la raiz el test se salta si no hay DATABASE_URL en el entorno.
}

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

const TOKEN = "integration-operator-token-0123456789abcdef";
const OTHER_TOKEN = "integration-other-token-0123456789abcdefg";
const SERVICE = "integration-checkout";

/** Plan que devolvería `mcp-ops` para un rollback. */
const PLAN = {
  kind: "rollback",
  target: SERVICE,
  risk: "alto",
  summary: `rollback de ${SERVICE} de 1.1.0 a 1.0.0`,
  diff: {
    kind: "rollback",
    service: SERVICE,
    from_version: "1.1.0",
    to_version: "1.0.0",
    rollout_percent: 100,
    commit_sha: "0123456",
    files_changed: 2,
  },
  blast_radius: {
    service: SERVICE,
    tier: "critical",
    owner_team: "payments",
    dependents: ["cart"],
    dependency_count: 1,
  },
  evidence: ["despliegue actual 1.1.0 (0123456)"],
};

/** Rate limit que permite todo: en este test no se prueba el rate limit. */
const allowAllRateLimiter = {
  async consume() {
    return {
      allowed: true,
      scope: null,
      limit: 0,
      observed: 0,
      retryAfterMs: null,
    };
  },
};

describeIntegration("escrituras en dos fases contra Postgres real (ADR-004)", () => {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const slug = `it-${randomUUID().slice(0, 8)}`;
  const otherSlug = `it-other-${randomUUID().slice(0, 8)}`;

  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }

    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
      tenantId,
      slug,
      `Integration ${slug}`,
    ]);
    await pool.query(
      "insert into users (id, tenant_id, email, display_name) values ($1, $2, $3, $4)",
      [userId, tenantId, `it-${slug}@shop.test`, "Integration user"],
    );
    await pool.query(
      `insert into agents (id, tenant_id, name, model, prompt_version, allowed_tools)
       values ($1, $2, $3, $4, $5, $6::text[])`,
      [
        agentId,
        tenantId,
        `it-agent-${slug}`,
        "mock",
        "m2-v0",
        ["propose_rollback", "propose_set_flag", "propose_silence_alert"],
      ],
    );
    // El estado simulado del test empieza limpio: la primera escritura lo crea.
    await pool.query("delete from simulated_state where target = $1", [`service:${SERVICE}`]);

    const db = drizzle(pool);
    const audit = new DrizzleAuditLog(db);
    const proposals = new DrizzleProposalStore(db);
    const effects = new DrizzleEffectLedger(db);
    const state = new DrizzleActionStateStore(db);

    const directory: PrincipalDirectory = {
      async resolve(selection) {
        if (selection.tenant !== slug) {
          return null;
        }
        return {
          principal: { tenantId, userId, agentId },
          agent: {
            name: "it-agent",
            model: "mock",
            promptVersion: "m2-v0",
            allowedTools: [
              "propose_rollback",
              "propose_set_flag",
              "propose_silence_alert",
            ],
            budgetCents: 10,
          },
        };
      },
    };

    const handle = createApp({
      config: loadConfig({
        NODE_ENV: "test",
        PORT: "3000",
        LOG_LEVEL: "silent",
        DATABASE_URL: DATABASE_URL ?? "postgresql://unused",
        AUTH_TOKENS_JSON: JSON.stringify({
          [TOKEN]: { tenant: slug, user: `it-${slug}@shop.test`, agent: "it-agent" },
          [OTHER_TOKEN]: {
            tenant: otherSlug,
            user: `it-${otherSlug}@shop.test`,
            agent: "it-agent",
          },
        }),
        MCP_URL: "http://127.0.0.1:4000/mcp",
        MCP_AUTH_TOKEN: "service-token-0123456789abcdef0123456789",
      }),
      logger: false,
      store: new MemoryRunStore(),
      directory,
      audit,
      proposalStore: proposals,
      effectLedger: effects,
      executor: new SimulatedExecutor({ state }),
      gatewayFactory: (agent: AgentBinding) =>
        createToolGateway({
          transport: {
            async callTool() {
              return PLAN;
            },
          },
          allowedTools: agent.allowedTools,
          audit,
          rateLimiter: allowAllRateLimiter,
          actor: `agent:${agent.name}`,
          proposals,
        }),
    });

    app = handle.app;
    close = handle.close;
  });

  afterAll(async () => {
    await close?.();
    if (pool) {
      await pool.query("delete from tenants where id = $1", [tenantId]);
      await pool.query("delete from simulated_state where target = $1", [`service:${SERVICE}`]);
      await pool.end();
    }
  });

  const AUTH = { authorization: `Bearer ${TOKEN}` };

  async function propose(reason = "pico de 5xx"): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/proposals",
      headers: AUTH,
      payload: {
        tool: "propose_rollback",
        args: { service: SERVICE, to_version: "1.0.0", reason },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { proposal } = created.json<{ proposal: { proposal_id: string } }>();
    return proposal.proposal_id;
  }

  it("abre una propuesta que queda pendiente de un humano", async () => {
    const proposalId = await propose("motivo-listar");

    const listed = await app.inject({ method: "GET", url: "/proposals", headers: AUTH });
    expect(listed.statusCode).toBe(200);
    const { proposals } = listed.json<{
      proposals: Array<{ proposal: { id: string; status: string }; approval: unknown }>;
    }>();
    expect(proposals.map((item) => item.proposal.id)).toContain(proposalId);
    expect(proposals.every((item) => item.proposal.status === "pending_approval")).toBe(true);
    // La cola viene con su decisión y su efecto, aunque todavía no los tenga.
    expect(proposals.every((item) => item.approval === null)).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/proposals/${proposalId}`,
      headers: AUTH,
    });
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{ proposal: { proposal: { id: string } } }>().proposal.proposal.id,
    ).toBe(proposalId);
  });

  it("no ejecuta nada hasta que un humano aprueba", async () => {
    const proposalId = await propose("motivo-aprobar");

    const before = await pool.query("select state from simulated_state where target = $1", [
      `service:${SERVICE}`,
    ]);
    expect(before.rows).toHaveLength(0);

    const approved = await app.inject({
      method: "POST",
      url: `/proposals/${proposalId}/approve`,
      headers: AUTH,
      payload: { reason: "adelante" },
    });

    expect(approved.statusCode).toBe(200);
    const body = approved.json<{
      proposal: {
        proposal: { status: string };
        effect: { status: string; verified: boolean; observedState: unknown };
      };
      replayed: boolean;
    }>();
    expect(body.replayed).toBe(false);
    expect(body.proposal.effect.status).toBe("applied");
    expect(body.proposal.effect.verified).toBe(true);
    expect(body.proposal.proposal.status).toBe("applied");
    expect(body.proposal.effect.observedState).toMatchObject({ version: "1.0.0" });

    // El efecto se ve en Postgres: el estado simulado cambio de verdad.
    const after = await pool.query(
      "select state, version from simulated_state where target = $1",
      [`service:${SERVICE}`],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.state).toMatchObject({ version: "1.0.0", rollout_percent: 100 });
  });

  it("repetir la aprobacion no vuelve a ejecutar la escritura", async () => {
    const proposalId = await propose("motivo-reintento");

    const first = await app.inject({
      method: "POST",
      url: `/proposals/${proposalId}/approve`,
      headers: AUTH,
      payload: { reason: "adelante" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/proposals/${proposalId}/approve`,
      headers: AUTH,
      payload: { reason: "adelante" },
    });

    expect(first.json<{ replayed: boolean }>().replayed).toBe(false);
    expect(second.json<{ replayed: boolean }>().replayed).toBe(true);

    const effects = await pool.query(
      "select count(*)::int as count from action_effects where proposal_id = $1",
      [proposalId],
    );
    expect(effects.rows[0]?.count).toBe(1);
  });

  it("una propuesta rechazada no se ejecuta", async () => {
    const proposalId = await propose("motivo-rechazar");

    const rejected = await app.inject({
      method: "POST",
      url: `/proposals/${proposalId}/reject`,
      headers: AUTH,
      payload: { reason: "no es el momento" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      rejected.json<{ proposal: { proposal: { status: string } } }>().proposal.proposal.status,
    ).toBe("rejected");

    const approved = await app.inject({
      method: "POST",
      url: `/proposals/${proposalId}/approve`,
      headers: AUTH,
      payload: { reason: "adelante" },
    });
    expect(approved.statusCode).toBe(409);

    const effects = await pool.query(
      "select count(*)::int as count from action_effects where proposal_id = $1",
      [proposalId],
    );
    expect(effects.rows[0]?.count).toBe(0);
  });

  it("la cadena de audit sigue verificandose con las dos fases dentro", async () => {
    const proposalId = await propose("motivo-audit");

    await app.inject({
      method: "POST",
      url: `/proposals/${proposalId}/approve`,
      headers: AUTH,
      payload: { reason: "adelante" },
    });

    const verified = await app.inject({ method: "GET", url: "/audit/verify", headers: AUTH });
    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ ok: boolean }>().ok).toBe(true);

    const actions = await pool.query(
      "select action from audit_log where actor = $1 order by id",
      [`user:${userId}`],
    );
    expect(actions.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["proposal.approved", "action.applied"]),
    );
  });

  it("otro tenant no ve la propuesta", async () => {
    const proposalId = await propose("motivo-tenant");

    const other = await app.inject({
      method: "GET",
      url: `/proposals/${proposalId}`,
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(other.statusCode).toBe(403);
  });
});
