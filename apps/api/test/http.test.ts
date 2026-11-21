import type { RunTimeline } from "@beacon/core/domain/runs";
import type { ToolCallResult, ToolGateway } from "@beacon/core/ports/tool-gateway";
import {
  MOCK_MODEL_ID,
  MOCK_PROMPT_VERSION,
} from "@beacon/orchestrator/mock-model";
import type { RunResult } from "@beacon/orchestrator/orchestrator";
import { describe, expect, it } from "vitest";

import type {
  AgentBinding,
  PrincipalDirectory,
  ResolvedPrincipal,
} from "../src/application/principal-directory.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryAuditLog } from "./support/memory-audit-log.js";
import { MemoryEffectLedger } from "./support/memory-effect-ledger.js";
import { MemoryProposalStore } from "./support/memory-proposal-store.js";
import { MemoryRunStore } from "./support/memory-run-store.js";

const TOKEN = "test-operator-token-0123456789abcdef";
const ALLOWED_TOOLS = ["query_metrics", "get_deploys", "search_runbooks"] as const;

const config = loadConfig({
  NODE_ENV: "test",
  PORT: "3000",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://unused",
  AUTH_TOKENS_JSON: JSON.stringify({
    [TOKEN]: {
      tenant: "shop",
      user: "oncall@shop.test",
      agent: "incident-copilot",
    },
  }),
  MCP_URL: "http://127.0.0.1:4000/mcp",
  MCP_AUTH_TOKEN: "service-token-0123456789abcdef0123456789",
});

const RESOLVED: ResolvedPrincipal = {
  principal: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
  },
  agent: {
    name: "incident-copilot",
    model: MOCK_MODEL_ID,
    promptVersion: MOCK_PROMPT_VERSION,
    allowedTools: ALLOWED_TOOLS,
    budgetCents: 10,
  },
};

const DEFAULT_DIRECTORY: PrincipalDirectory = {
  async resolve(selection) {
    return selection.tenant === "shop" ? RESOLVED : null;
  },
};

function toolResult(tool: string): unknown {
  switch (tool) {
    case "query_metrics":
      return {
        service: "checkout",
        metric: "http_5xx_rate",
        points: [
          { ts: "2026-11-19T19:30:00.000Z", value: 4.2 },
          { ts: "2026-11-19T19:35:00.000Z", value: 6.1 },
        ],
      };
    case "get_deploys":
      return { service: "checkout", deploys: [{ version: "v2.3.4" }] };
    case "search_runbooks":
      return { runbooks: [{ slug: "rollback-checkout" }] };
    default:
      return {};
  }
}

function buildApp(overrides: { directory?: PrincipalDirectory; store?: MemoryRunStore } = {}) {
  const store = overrides.store ?? new MemoryRunStore();
  const audit = new MemoryAuditLog();
  const calls: string[] = [];

  const gatewayFactory = (agent: AgentBinding): ToolGateway => {
    expect(agent.allowedTools).toEqual([...ALLOWED_TOOLS]);
    expect(agent.name).toBe("incident-copilot");
    return {
      async call(tool): Promise<ToolCallResult> {
        calls.push(tool);
        return { result: toolResult(tool), latencyMs: 1 };
      },
    };
  };

  const handle = createApp({
    config,
    logger: false,
    store,
    directory: overrides.directory ?? DEFAULT_DIRECTORY,
    audit,
    proposalStore: new MemoryProposalStore(),
    effectLedger: new MemoryEffectLedger(),
    gatewayFactory,
  });

  return { ...handle, store, calls, audit };
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

describe("API HTTP", () => {
  it("ejecuta un run y devuelve su timeline persistida", async () => {
    const { app, close, store, calls } = buildApp();

    try {
      const post = await app.inject({
        method: "POST",
        url: "/runs",
        headers: AUTH,
        payload: { goal: "investiga el pico de 5xx en checkout", trigger: "cli" },
      });

      expect(post.statusCode).toBe(201);
      const { run } = post.json<{ run: RunResult }>();
      expect(run).toMatchObject({ status: "succeeded", errorCode: null, turns: 4 });
      expect(run.answer?.finding).toContain("6.1");
      expect(post.headers.location).toBe(`/runs/${run.runId}`);
      expect(calls).toEqual(["query_metrics", "get_deploys", "search_runbooks"]);

      const get = await app.inject({
        method: "GET",
        url: `/runs/${run.runId}`,
        headers: AUTH,
      });

      expect(get.statusCode).toBe(200);
      const timeline = get.json<RunTimeline>();
      expect(timeline.run.id).toBe(run.runId);
      expect(timeline.steps.map((step) => step.kind)).toEqual([
        "model",
        "tool",
        "model",
        "tool",
        "model",
        "tool",
        "model",
      ]);
      const toolSteps = timeline.steps.filter((step) => step.kind === "tool");
      expect(toolSteps.map((step) => step.toolCalls[0]?.tool)).toEqual([
        "query_metrics",
        "get_deploys",
        "search_runbooks",
      ]);
      expect(toolSteps.every((step) => step.toolCalls[0]?.status === "ok")).toBe(true);
      expect(toolSteps[0]?.toolCalls[0]?.argsRedacted).toMatchObject({
        service: "checkout",
        metric: "http_5xx_rate",
      });
      expect(store.runs.get(run.runId)?.status).toBe("succeeded");
    } finally {
      await close();
    }
  });

  it("rechaza una petición sin bearer o con token incorrecto", async () => {
    const { app, close, store } = buildApp();

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { goal: "investiga" },
      });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers["www-authenticate"]).toBe("Bearer");
      expect(missing.json()).toMatchObject({ error: { code: "unauthorized" } });

      const wrong = await app.inject({
        method: "POST",
        url: "/runs",
        headers: { authorization: "Bearer otro-token-0123456789abcdef" },
        payload: { goal: "investiga" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(store.events).toEqual([]);
    } finally {
      await close();
    }
  });

  it("responde 403 si el token no apunta a un principal activo", async () => {
    const { app, close } = buildApp({
      directory: { async resolve() { return null; } },
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        headers: AUTH,
        payload: { goal: "investiga" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "forbidden" } });
    } finally {
      await close();
    }
  });

  it("valida el body y el id del run en el borde", async () => {
    const { app, close } = buildApp();

    try {
      const emptyGoal = await app.inject({
        method: "POST",
        url: "/runs",
        headers: AUTH,
        payload: { goal: "  " },
      });
      expect(emptyGoal.statusCode).toBe(400);
      expect(emptyGoal.json()).toMatchObject({ error: { code: "invalid_input" } });

      const badId = await app.inject({
        method: "GET",
        url: "/runs/no-es-un-uuid",
        headers: AUTH,
      });
      expect(badId.statusCode).toBe(400);
      expect(badId.json()).toMatchObject({ error: { code: "invalid_input" } });
    } finally {
      await close();
    }
  });

  it("devuelve 404 para un run inexistente", async () => {
    const { app, close } = buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/runs/44444444-4444-4444-8444-444444444444",
        headers: AUTH,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "not_found" } });
    } finally {
      await close();
    }
  });

  it("expone health sin autenticación", async () => {
    const { app, close } = buildApp();

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", service: "beacon-api" });
    } finally {
      await close();
    }
  });

  it("verifica la cadena de audit solo con token válido", async () => {
    const { app, close } = buildApp();

    try {
      const missing = await app.inject({ method: "GET", url: "/audit/verify" });
      expect(missing.statusCode).toBe(401);

      const response = await app.inject({
        method: "GET",
        url: "/audit/verify",
        headers: AUTH,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, brokenAt: null });
    } finally {
      await close();
    }
  });
});