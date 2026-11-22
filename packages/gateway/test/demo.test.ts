import { AppError } from "@beacon/core/errors/app-error";
import type { ToolCallContext } from "@beacon/core/ports/tool-gateway";
import { describe, expect, it } from "vitest";

import { createToolGateway, type DemoGatewayPolicy } from "../src/gateway.js";
import type { McpTransport } from "../src/transport.js";
import { FakeAuditLog } from "./support/fake-audit.js";
import { FakeDemoSessions } from "./support/fake-demo-sessions.js";
import { FakeProposalStore } from "./support/fake-proposal-store.js";
import { FakeRateLimiter } from "./support/fake-rate-limiter.js";

/**
 * Politica de la demo publica (plan §4.11 y §12). El gateway es el punto de
 * enforcement; la UI solo lee el estado. Estos casos viven junto a la suite de
 * politicas para que una regla nueva no quede sin prueba.
 */

const CONTEXT: ToolCallContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  stepIdx: 1,
};

function demoPolicy(
  sessions: FakeDemoSessions,
  overrides: Partial<DemoGatewayPolicy> = {},
): DemoGatewayPolicy {
  return {
    sessions,
    sessionId: "demo-session-1",
    ip: "203.0.113.7",
    maxCostCents: 5,
    maxSteps: 6,
    sessionTtlMs: 3_600_000,
    dailyLimit: 200,
    failureThreshold: 2,
    replayOnly: false,
    ...overrides,
  };
}

function harness() {
  const primaryCalls: string[] = [];
  const replayCalls: string[] = [];
  const transport: McpTransport = {
    async callTool(request) {
      primaryCalls.push(request.name);
      return { ok: true, source: "mcp-ops" };
    },
  };
  const replayTransport: McpTransport = {
    async callTool(request) {
      replayCalls.push(request.name);
      return { ok: true, source: "replay" };
    },
  };
  return {
    primaryCalls,
    replayCalls,
    transport,
    replayTransport,
    audit: new FakeAuditLog(),
    rateLimiter: new FakeRateLimiter(),
    proposals: new FakeProposalStore(),
  };
}

describe("DEMO_MODE en el gateway", () => {
  it("pasa la sesion y la IP al rate limit y mantiene el presupuesto de sesion", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      demo: demoPolicy(sessions, { replayTransport: h.replayTransport }),
    });

    const first = await gateway.call("list_services", {}, CONTEXT);
    expect(first.result).toMatchObject({ source: "mcp-ops" });
    expect(h.rateLimiter.calls[0]?.sessionId).toBe("demo-session-1");
    expect(h.rateLimiter.calls[0]?.ip).toBe("203.0.113.7");
    expect(sessions.charges).toHaveLength(1);
  });

  it("corta al superar el techo de steps de la sesion", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      demo: demoPolicy(sessions, { maxSteps: 1, replayTransport: h.replayTransport }),
    });

    await gateway.call("list_services", {}, CONTEXT);
    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
      code: "budget_exceeded",
      statusCode: 402,
    });
    expect(h.primaryCalls).toHaveLength(1);
  });

  it("corta al superar el techo de coste de la sesion", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      usageMeter: {
        estimate: () => ({ tokensIn: 0, tokensOut: 0, costCents: 3, wallMs: 0 }),
      },
      demo: demoPolicy(sessions, { maxCostCents: 5, replayTransport: h.replayTransport }),
    });

    await gateway.call("list_services", {}, CONTEXT);
    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    expect(sessions.spentCents).toBe(3);
  });

  it("en REPLAY_ONLY sirve reads desde fixtures y no llama a mcp-ops", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    sessions.replayOnly = true;
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      demo: demoPolicy(sessions, { replayTransport: h.replayTransport }),
    });

    const result = await gateway.call("list_services", {}, CONTEXT);
    expect(result.result).toMatchObject({ source: "replay" });
    expect(h.primaryCalls).toHaveLength(0);
    expect(h.replayCalls).toEqual(["list_services"]);
  });

  it("en REPLAY_ONLY deniega las escrituras aunque esten en la allowlist", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    sessions.replayOnly = true;
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["propose_rollback"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      proposals: h.proposals,
      demo: demoPolicy(sessions, { replayTransport: h.replayTransport }),
    });

    await expect(
      gateway.call(
        "propose_rollback",
        { service: "checkout", to_version: "v1.41.0", reason: "pico de 5xx" },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(h.primaryCalls).toHaveLength(0);
    expect(h.replayCalls).toHaveLength(0);
  });

  it("si no hay fixtures, REPLAY_ONLY falla cerrado en vez de llamar a mcp-ops", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    sessions.replayOnly = true;
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      demo: demoPolicy(sessions),
    });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
      code: "upstream_error",
      statusCode: 503,
    });
    expect(h.primaryCalls).toHaveLength(0);
  });

  it("un fallo de dependencia dispara el breaker y la siguiente llamada cae a replay", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    const failing: McpTransport = {
      async callTool() {
        throw new Error("mcp-ops no responde");
      },
    };
    const gateway = createToolGateway({
      transport: failing,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      demo: demoPolicy(sessions, {
        failureThreshold: 1,
        replayTransport: h.replayTransport,
      }),
    });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toThrow("mcp-ops no responde");
    expect(sessions.recordFailures).toHaveLength(1);

    const result = await gateway.call("list_services", {}, CONTEXT);
    expect(result.result).toMatchObject({ source: "replay" });
    expect(h.replayCalls).toEqual(["list_services"]);
  });

  it("una sesion caducada se rechaza con 429", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    sessions.expired = true;
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      demo: demoPolicy(sessions, { replayTransport: h.replayTransport }),
    });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
      code: "rate_limited",
      statusCode: 429,
    });
    expect(h.primaryCalls).toHaveLength(0);
  });

  it("una sesion sin presupuesto no consume rate limit ni llama a la tool", async () => {
    const h = harness();
    const sessions = new FakeDemoSessions();
    sessions.steps = 6;
    const gateway = createToolGateway({
      transport: h.transport,
      allowedTools: ["list_services"],
      audit: h.audit,
      rateLimiter: h.rateLimiter,
      actor: "agent:incident-copilot",
      demo: demoPolicy(sessions, { maxSteps: 6, replayTransport: h.replayTransport }),
    });

    const error = await gateway
      .call("list_services", {}, CONTEXT)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect(h.primaryCalls).toHaveLength(0);
    expect(h.audit.entries.some((entry) => entry.action === "tool.call.denied")).toBe(true);
  });
});
