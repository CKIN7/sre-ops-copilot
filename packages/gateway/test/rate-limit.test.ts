import type { ToolCallContext } from "@beacon/core/ports/tool-gateway";
import { describe, expect, it } from "vitest";

import { createToolGateway } from "../src/gateway.js";
import type { McpTransport } from "../src/transport.js";
import { FakeAuditLog } from "./support/fake-audit.js";
import { FakeRateLimiter } from "./support/fake-rate-limiter.js";

const CONTEXT: ToolCallContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  stepIdx: 1,
};

const ACTOR = "agent:incident-copilot";

function recordingTransport(): { transport: McpTransport; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async callTool(request) {
        calls.push(request.name);
        return { ok: true };
      },
    },
  };
}

describe("política de rate limit del gateway", () => {
  it("deja pasar la llamada cuando ningún ámbito rebasa el límite", async () => {
    const rateLimiter = new FakeRateLimiter();
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit: new FakeAuditLog(),
      rateLimiter,
      actor: ACTOR,
    });

    await gateway.call("list_services", {}, CONTEXT);

    expect(calls).toEqual(["list_services"]);
    expect(rateLimiter.calls).toEqual([
      { tenantId: CONTEXT.tenantId, runId: CONTEXT.runId, tool: "list_services" },
    ]);
  });

  it("rechaza con 429 cuando el límite rebasa y no llama al transporte", async () => {
    const rateLimiter = new FakeRateLimiter();
    rateLimiter.deny = { scope: "tenant", limit: 600, observed: 600 };
    const audit = new FakeAuditLog();
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit,
      rateLimiter,
      actor: ACTOR,
    });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
      code: "rate_limited",
      statusCode: 429,
    });

    expect(calls).toHaveLength(0);
  });

  it("audita la denegación por rate limit con el ambito que rebaso", async () => {
    const rateLimiter = new FakeRateLimiter();
    rateLimiter.deny = { scope: "tool", limit: 120, observed: 121 };
    const audit = new FakeAuditLog();
    const { transport } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit,
      rateLimiter,
      actor: ACTOR,
    });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
      code: "rate_limited",
    });

    expect(audit.entries.map((entry) => entry.action)).toEqual(["tool.call.denied"]);
    expect(audit.entries[0]?.payload).toMatchObject({
      reason: "rate_limited",
      scope: "tool",
      limit: 120,
    });
  });

  it("no consume el rate limit de una tool ya denegada por la allowlist", async () => {
    const rateLimiter = new FakeRateLimiter();
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit: new FakeAuditLog(),
      rateLimiter,
      actor: ACTOR,
    });

    await expect(
      gateway.call("search_logs", { service: "checkout", query: "x", window: "1h" }, CONTEXT),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(rateLimiter.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
