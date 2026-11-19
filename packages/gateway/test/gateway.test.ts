import { DEFAULT_LOG_LINES } from "@beacon/core/domain/read-tools";
import { AppError } from "@beacon/core/errors/app-error";
import type { ToolCallContext } from "@beacon/core/ports/tool-gateway";
import { describe, expect, it } from "vitest";

import { createToolGateway } from "../src/gateway.js";
import type { McpToolRequest, McpTransport } from "../src/transport.js";

const CONTEXT: ToolCallContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  stepIdx: 1,
};

function fakeTransport(result: unknown = { ok: true }): {
  transport: McpTransport;
  calls: McpToolRequest[];
} {
  const calls: McpToolRequest[] = [];
  return {
    calls,
    transport: {
      async callTool(request) {
        calls.push(request);
        return result;
      },
    },
  };
}

describe("createToolGateway", () => {
  it("valida, aplica defaults y devuelve el resultado con latencia", async () => {
    const { transport, calls } = fakeTransport({ returned: 3 });
    const gateway = createToolGateway({ transport, allowedTools: ["search_logs"] });

    const outcome = await gateway.call(
      "search_logs",
      { service: "checkout", query: "psp", window: "1h" },
      CONTEXT,
    );

    expect(outcome.result).toEqual({ returned: 3 });
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("search_logs");
    expect(calls[0]?.args).toMatchObject({ service: "checkout", limit: DEFAULT_LOG_LINES });
  });

  it("rechaza una tool fuera de la allowlist sin llamar al transporte", async () => {
    const { transport, calls } = fakeTransport();
    const gateway = createToolGateway({ transport, allowedTools: ["list_services"] });

    await expect(gateway.call("search_logs", { service: "checkout", query: "x" }, CONTEXT)).rejects.toMatchObject(
      { code: "forbidden", statusCode: 403 },
    );
    expect(calls).toHaveLength(0);
  });

  it("rechaza un nombre de tool desconocido aunque intente colarse", async () => {
    const { transport, calls } = fakeTransport();
    const gateway = createToolGateway({ transport, allowedTools: ["list_services"] });

    await expect(
      // El modelo puede emitir cualquier string; el tipo es una promesa, no una garantía.
      gateway.call("drop_table" as never, {}, CONTEXT),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toHaveLength(0);
  });

  it("rechaza argumentos inválidos antes de salir a la red", async () => {
    const { transport, calls } = fakeTransport();
    const gateway = createToolGateway({ transport, allowedTools: ["query_metrics"] });

    await expect(
      gateway.call(
        "query_metrics",
        { service: "checkout", metric: "http_5xx_rate", window: "48h", step: "1m" },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "invalid_input", statusCode: 400 });
    expect(calls).toHaveLength(0);
  });

  it("falla al construirse si la allowlist tiene una tool inexistente", () => {
    const { transport } = fakeTransport();

    expect(() => createToolGateway({ transport, allowedTools: ["not_a_tool"] })).toThrow(
      /unknown tools in allowlist/,
    );
  });

  it("una allowlist vacía bloquea todas las tools", async () => {
    const { transport, calls } = fakeTransport();
    const gateway = createToolGateway({ transport, allowedTools: [] });

    await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(calls).toHaveLength(0);
  });
});