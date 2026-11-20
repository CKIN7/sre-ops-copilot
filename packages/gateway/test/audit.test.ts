import type { ToolCallContext } from "@beacon/core/ports/tool-gateway";
import { describe, expect, it } from "vitest";

import { createToolGateway } from "../src/gateway.js";
import type { McpTransport } from "../src/transport.js";
import { FakeAuditLog } from "./support/fake-audit.js";

const CONTEXT: ToolCallContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  stepIdx: 1,
};

const ACTOR = "agent:incident-copilot";

function recordingTransport(options: { throws?: boolean } = {}): {
  transport: McpTransport;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async callTool(request) {
        calls.push(request.name);
        if (options.throws) {
          throw new Error("upstream caído");
        }
        return { ok: true };
      },
    },
  };
}

describe("política de audit del gateway", () => {
  it("audita la decisión antes de invocar la tool", async () => {
    const audit = new FakeAuditLog();
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit,
      actor: ACTOR,
    });

    await gateway.call("list_services", {}, CONTEXT);

    expect(calls).toEqual(["list_services"]);
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "tool.call.allowed",
      "tool.call.result",
    ]);
    expect(audit.entries[0]).toMatchObject({
      tenantId: CONTEXT.tenantId,
      actor: ACTOR,
      target: `list_services#${CONTEXT.runId}`,
    });
    expect(audit.entries[0]?.payload).toMatchObject({
      user_id: CONTEXT.userId,
      step_idx: CONTEXT.stepIdx,
    });
  });

  it("audita la denegación y no llama al transporte", async () => {
    const audit = new FakeAuditLog();
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit,
      actor: ACTOR,
    });

    await expect(
      gateway.call("search_logs", { service: "checkout", query: "x", window: "1h" }, CONTEXT),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(calls).toHaveLength(0);
    expect(audit.entries.map((entry) => entry.action)).toEqual(["tool.call.denied"]);
  });

  it("audita los argumentos inválidos como denegación", async () => {
    const audit = new FakeAuditLog();
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["query_metrics"],
      audit,
      actor: ACTOR,
    });

    await expect(
      gateway.call(
        "query_metrics",
        { service: "checkout", metric: "http_5xx_rate", window: "48h", step: "1m" },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(calls).toHaveLength(0);
    expect(audit.entries[0]).toMatchObject({ action: "tool.call.denied" });
  });

  it("audita el error del transporte y propaga el fallo", async () => {
    const audit = new FakeAuditLog();
    const { transport } = recordingTransport({ throws: true });
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit,
      actor: ACTOR,
    });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toThrow();

    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "tool.call.allowed",
      "tool.call.error",
    ]);
  });

  it("no persiste en claro un email ni un token en los args auditados", async () => {
    const audit = new FakeAuditLog();
    const { transport } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["search_logs"],
      audit,
      actor: ACTOR,
    });

    // Un query de logs puede traer PII: la redacción ocurre antes de persistir.
    await gateway.call(
      "search_logs",
      {
        service: "checkout",
        query: "user=oncall@shop.test token=sk_live_abcdefghijklmnop",
        window: "1h",
      },
      CONTEXT,
    );

    const payload = JSON.stringify(audit.entries[0]?.payload);
    expect(payload).not.toContain("oncall@shop.test");
    expect(payload).not.toContain("sk_live_abcdefghijklmnop");
    expect(payload).toContain("[redacted:email]");
    expect(payload).toContain("[redacted:secret]");
  });

  it("falla cerrado: si el audit no está disponible, la tool no se invoca", async () => {
    const audit = new FakeAuditLog();
    audit.unavailable = true;
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit,
      actor: ACTOR,
    });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toThrow(
      /audit no disponible/,
    );
    expect(calls).toHaveLength(0);
  });

  it("mantiene la denegación aunque no se pueda auditar", async () => {
    const audit = new FakeAuditLog();
    audit.unavailable = true;
    const errors: unknown[] = [];
    const { transport, calls } = recordingTransport();
    const gateway = createToolGateway({
      transport,
      allowedTools: ["list_services"],
      audit,
      actor: ACTOR,
      onError: (error) => errors.push(error),
    });

    await expect(
      gateway.call("search_logs", { service: "checkout", query: "x", window: "1h" }, CONTEXT),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});
