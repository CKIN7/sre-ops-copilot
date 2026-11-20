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

function transportWith(result: unknown): McpTransport {
  return {
    async callTool() {
      return result;
    },
  };
}

describe("redaccion en el gateway", () => {
  it("redacta el resultado antes de devolverlo", async () => {
    const gateway = createToolGateway({
      transport: transportWith({
        lines: [{ message: "login de oncall@shop.test desde 10.0.0.7" }],
      }),
      allowedTools: ["search_logs"],
      audit: new FakeAuditLog(),
      rateLimiter: new FakeRateLimiter(),
      actor: ACTOR,
    });

    const outcome = await gateway.call(
      "search_logs",
      { service: "checkout", query: "login", window: "1h" },
      CONTEXT,
    );

    const result = JSON.stringify(outcome.result);
    expect(result).not.toContain("oncall@shop.test");
    expect(result).not.toContain("10.0.0.7");
    expect(result).toContain("[redacted:email]");
    expect(result).toContain("[redacted:ip]");
  });

  it("redacta tambien el resultado que queda en el audit", async () => {
    const audit = new FakeAuditLog();
    const gateway = createToolGateway({
      transport: transportWith({ message: "token=sk_live_abcdefghijklmnop" }),
      allowedTools: ["search_logs"],
      audit,
      rateLimiter: new FakeRateLimiter(),
      actor: ACTOR,
    });

    await gateway.call(
      "search_logs",
      { service: "checkout", query: "token", window: "1h" },
      CONTEXT,
    );

    const payload = JSON.stringify(audit.entries.at(-1)?.payload);
    expect(payload).not.toContain("sk_live_abcdefghijklmnop");
    expect(payload).toContain("[redacted:secret]");
  });

  it("no toca los valores que no son secretos", async () => {
    const gateway = createToolGateway({
      transport: transportWith({
        service: "checkout",
        metric: "http_5xx_rate",
        points: [{ ts: "2026-11-20T14:00:00.000Z", value: 0.041 }],
        deploy: "checkout@1.42.0",
      }),
      allowedTools: ["query_metrics"],
      audit: new FakeAuditLog(),
      rateLimiter: new FakeRateLimiter(),
      actor: ACTOR,
    });

    const outcome = await gateway.call(
      "query_metrics",
      { service: "checkout", metric: "http_5xx_rate", window: "2h", step: "5m" },
      CONTEXT,
    );

    expect(outcome.result).toMatchObject({
      service: "checkout",
      metric: "http_5xx_rate",
      points: [{ value: 0.041 }],
      deploy: "checkout@1.42.0",
    });
  });
});
