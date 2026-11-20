import type { ToolCallContext } from "@beacon/core/ports/tool-gateway";
import { describe, expect, it } from "vitest";

import { createToolGateway } from "../src/gateway.js";
import type { McpTransport } from "../src/transport.js";
import { FakeAuditLog } from "./support/fake-audit.js";
import { FakeRateLimiter } from "./support/fake-rate-limiter.js";

/**
 * Suite de políticas del gateway (docs/plan.md §14, DoD de M3).
 *
 * Este archivo es el **inventario** de reglas: cada regla del gateway tiene su caso
 * aquí. Si se añade una regla al gateway y no se añade a esta tabla, la suite deja
 * de ser la cobertura de políticas y pasa a ser un montón de tests sueltos.
 *
 * Las reglas salen de `docs/plan.md` §4 y del ADR-003 (gateway como punto único de
 * enforcement).
 */

const CONTEXT: ToolCallContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  stepIdx: 1,
};

const ACTOR = "agent:incident-copilot";

interface Harness {
  transport: McpTransport;
  calls: string[];
  audit: FakeAuditLog;
  rateLimiter: FakeRateLimiter;
}

function harness(result: unknown = { ok: true }): Harness {
  const calls: string[] = [];
  return {
    calls,
    audit: new FakeAuditLog(),
    rateLimiter: new FakeRateLimiter(),
    transport: {
      async callTool(request) {
        calls.push(request.name);
        return result;
      },
    },
  };
}

function gatewayOf(
  h: Harness,
  allowedTools: readonly string[] = ["list_services", "search_logs"],
) {
  return createToolGateway({
    transport: h.transport,
    allowedTools,
    audit: h.audit,
    rateLimiter: h.rateLimiter,
    actor: ACTOR,
  });
}

interface PolicyRule {
  id: string;
  regla: string;
  comprueba: () => Promise<void>;
}

const REGLAS: PolicyRule[] = [
  {
    id: "allowlist",
    regla: "una tool fuera de la allowlist no llega a mcp-ops",
    comprueba: async () => {
      const h = harness();
      await expect(
        gatewayOf(h).call(
          "get_feature_flags",
          { service: "checkout" },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    id: "allowlist-vacia",
    regla: "una allowlist vacia bloquea todas las tools",
    comprueba: async () => {
      const h = harness();
      await expect(
        gatewayOf(h, []).call("list_services", {}, CONTEXT),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    id: "validacion",
    regla: "los argumentos se validan contra el contrato de la tool antes de salir",
    comprueba: async () => {
      const h = harness();
      await expect(
        gatewayOf(h).call(
          "search_logs",
          { service: "checkout", query: "x", window: "48h" },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ code: "invalid_input", statusCode: 400 });
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    id: "rate-limit",
    regla: "una llamada que rebasa el limite se rechaza con 429 y no sale",
    comprueba: async () => {
      const h = harness();
      h.rateLimiter.deny = { scope: "tenant", limit: 600, observed: 600 };
      await expect(
        gatewayOf(h).call("list_services", {}, CONTEXT),
      ).rejects.toMatchObject({ code: "rate_limited", statusCode: 429 });
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    id: "rate-limit-antes-de-la-llamada",
    regla: "una tool denegada por la allowlist no consume presupuesto",
    comprueba: async () => {
      const h = harness();
      await expect(
        gatewayOf(h, ["list_services"]).call(
          "search_logs",
          { service: "checkout", query: "x", window: "1h" },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(h.rateLimiter.calls).toHaveLength(0);
    },
  },
  {
    id: "audit-todo-pasa",
    regla: "toda tool call permitida deja su decision y su resultado auditados",
    comprueba: async () => {
      const h = harness();
      await gatewayOf(h).call("list_services", {}, CONTEXT);
      expect(h.audit.entries.map((entry) => entry.action)).toEqual([
        "tool.call.allowed",
        "tool.call.result",
      ]);
    },
  },
  {
    id: "audit-denegaciones",
    regla: "toda denegacion queda auditada con su motivo",
    comprueba: async () => {
      const h = harness();
      await expect(
        gatewayOf(h, ["list_services"]).call(
          "search_logs",
          { service: "checkout", query: "x", window: "1h" },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(h.audit.entries.map((entry) => entry.action)).toEqual(["tool.call.denied"]);
      expect(h.audit.entries[0]?.payload).toMatchObject({ reason: "forbidden" });
    },
  },
  {
    id: "audit-redactado",
    regla: "el payload auditado nunca guarda secretos ni PII en claro",
    comprueba: async () => {
      const h = harness();
      await gatewayOf(h).call(
        "search_logs",
        {
          service: "checkout",
          query: "user=oncall@shop.test token=sk_live_abcdefghijklmnop",
          window: "1h",
        },
        CONTEXT,
      );
      const payload = JSON.stringify(h.audit.entries[0]?.payload);
      expect(payload).not.toContain("oncall@shop.test");
      expect(payload).not.toContain("sk_live_abcdefghijklmnop");
    },
  },
  {
    id: "audit-fallar-cerrado",
    regla: "si el audit no esta disponible, la tool no se invoca",
    comprueba: async () => {
      const h = harness();
      h.audit.unavailable = true;
      await expect(gatewayOf(h).call("list_services", {}, CONTEXT)).rejects.toThrow(
        /audit no disponible/,
      );
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    id: "redaccion-resultado",
    regla: "el resultado que vuelve al modelo va redactado",
    comprueba: async () => {
      const h = harness({ message: "login de oncall@shop.test" });
      const outcome = await gatewayOf(h).call(
        "search_logs",
        { service: "checkout", query: "login", window: "1h" },
        CONTEXT,
      );
      expect(JSON.stringify(outcome.result)).not.toContain("oncall@shop.test");
    },
  },
  {
    id: "identidad-server-side",
    regla: "la identidad de la auditoria viene del contexto, no del modelo",
    comprueba: async () => {
      const h = harness();
      await gatewayOf(h).call("list_services", {}, CONTEXT);
      expect(h.audit.entries[0]).toMatchObject({
        tenantId: CONTEXT.tenantId,
        actor: ACTOR,
        target: `list_services#${CONTEXT.runId}`,
      });
      expect(h.audit.entries[0]?.payload).toMatchObject({
        user_id: CONTEXT.userId,
        step_idx: CONTEXT.stepIdx,
      });
    },
  },
  {
    id: "sin-secretos-en-la-auditoria",
    regla: "la auditoria no contiene credenciales del servidor",
    comprueba: async () => {
      const h = harness();
      await gatewayOf(h).call("list_services", {}, CONTEXT);
      const payload = JSON.stringify(h.audit.entries);
      expect(payload).not.toContain("Bearer");
      expect(payload).not.toContain("MCP_AUTH_TOKEN");
      expect(Object.keys(h.audit.entries[0]?.payload as object)).toEqual(
        expect.arrayContaining(["user_id", "step_idx"]),
      );
    },
  },
];

describe("politicas del gateway", () => {
  it("cubre todas las reglas declaradas", () => {
    const ids = REGLAS.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  for (const rule of REGLAS) {
    it(`${rule.id}: ${rule.regla}`, rule.comprueba);
  }
});
