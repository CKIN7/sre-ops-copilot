import type { ActionApplier } from "@beacon/core/ports/action-applier";
import type { ToolCallContext, ToolGateway } from "@beacon/core/ports/tool-gateway";
import { describe, expect, it } from "vitest";

import { createActionApplier, createToolGateway } from "../src/gateway.js";
import type { McpTransport } from "../src/transport.js";
import { FakeAuditLog } from "./support/fake-audit.js";
import { FakeBudget } from "./support/fake-budget.js";
import { FakeEffectLedger } from "./support/fake-effect-ledger.js";
import { FakeExecutor } from "./support/fake-executor.js";
import { FakeProposalStore } from "./support/fake-proposal-store.js";
import { FakeRateLimiter } from "./support/fake-rate-limiter.js";

/**
 * Suite de políticas del gateway (docs/plan.md §14, DoD de M3 y M4).
 *
 * Este archivo es el **inventario** de reglas: cada regla del gateway tiene su caso
 * aquí. Si se añade una regla al gateway y no se añade a esta tabla, la suite deja
 * de ser la cobertura de políticas y pasa a ser un montón de tests sueltos.
 *
 * Las reglas salen de `docs/plan.md` §4 y §3.4, del ADR-003 (gateway como punto
 * único de enforcement), del ADR-004 (escrituras en dos fases) y del ADR-005
 * (puerto `ActionExecutor`).
 */

const CONTEXT: ToolCallContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  stepIdx: 1,
};

const ACTOR = "agent:incident-copilot";

const LIMITS = {
  perRun: { tokensIn: 1_000, tokensOut: 1_000, costCents: 10, wallMs: 90_000 },
  perTenant: { tokensIn: 10_000, tokensOut: 10_000, costCents: 100, wallMs: 3_600_000 },
};

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

/* -------------------------------------------------------------------------- */
/* Harness de las escrituras en dos fases (ADR-004)                            */
/* -------------------------------------------------------------------------- */

/** Plan que devuelve `mcp-ops` a una tool `propose_*`. */
const PLAN = {
  kind: "rollback",
  target: "checkout",
  risk: "alto",
  summary: "rollback de checkout de v2.3.4 a v2.3.3",
  diff: {
    kind: "rollback",
    service: "checkout",
    from_version: "v2.3.4",
    to_version: "v2.3.3",
    rollout_percent: 100,
    commit_sha: "abc1234",
    files_changed: 3,
  },
  blast_radius: {
    service: "checkout",
    tier: "critical",
    owner_team: "payments",
    dependents: ["cart"],
    dependency_count: 1,
  },
  evidence: ["despliegue actual v2.3.4 (abc1234)"],
};

interface WriteHarness {
  calls: string[];
  audit: FakeAuditLog;
  rateLimiter: FakeRateLimiter;
  proposals: FakeProposalStore;
  effects: FakeEffectLedger;
  executor: FakeExecutor;
  gateway: ToolGateway;
  applier: ActionApplier;
}

function writeHarness(): WriteHarness {
  const calls: string[] = [];
  const audit = new FakeAuditLog();
  const rateLimiter = new FakeRateLimiter();
  const proposals = new FakeProposalStore();
  const effects = new FakeEffectLedger();
  const executor = new FakeExecutor();

  const transport: McpTransport = {
    async callTool(request) {
      calls.push(request.name);
      return PLAN;
    },
  };

  const gateway = createToolGateway({
    transport,
    allowedTools: ["propose_rollback"],
    audit,
    rateLimiter,
    actor: ACTOR,
    proposals,
  });

  const applier = createActionApplier({
    proposals,
    effects,
    executor,
    audit,
    executorName: "simulated",
  });

  return { calls, audit, rateLimiter, proposals, effects, executor, gateway, applier };
}

/** Abre una propuesta y devuelve su id. */
async function propose(h: WriteHarness): Promise<string> {
  const outcome = await h.gateway.call(
    "propose_rollback",
    { service: "checkout", to_version: "v2.3.3", reason: "pico de 5xx" },
    CONTEXT,
  );
  const result = outcome.result as { proposal_id: string };
  return result.proposal_id;
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
  {
    id: "propuesta-pendiente-de-humano",
    regla: "una tool propose_* deja una propuesta pendiente con su approval_id",
    comprueba: async () => {
      const h = writeHarness();
      const outcome = await h.gateway.call(
        "propose_rollback",
        { service: "checkout", to_version: "v2.3.3", reason: "pico de 5xx" },
        CONTEXT,
      );

      expect(outcome.result).toMatchObject({
        status: "pending_approval",
        plan: { kind: "rollback", target: "checkout" },
      });
      expect(h.proposals.proposals.size).toBe(1);
      const proposal = [...h.proposals.proposals.values()][0];
      expect(proposal?.status).toBe("pending_approval");
      expect((outcome.result as { approval_id: string }).approval_id).toBe(
        proposal?.approvalId,
      );
    },
  },
  {
    id: "propuesta-idempotente",
    regla: "repetir la misma propuesta devuelve la misma, no abre otra discusion",
    comprueba: async () => {
      const h = writeHarness();
      const first = await propose(h);
      const second = await propose(h);

      expect(second).toBe(first);
      expect(h.proposals.proposals.size).toBe(1);
    },
  },
  {
    id: "propuesta-tenant-server-side",
    regla: "la propuesta pertenece al tenant del contexto, no al del modelo",
    comprueba: async () => {
      const h = writeHarness();
      await propose(h);

      const proposal = [...h.proposals.proposals.values()][0];
      expect(proposal?.tenantId).toBe(CONTEXT.tenantId);
    },
  },
  {
    id: "propuesta-redactada",
    regla: "los argumentos que se persisten y los que se ejecutan estan redactados",
    comprueba: async () => {
      const h = writeHarness();
      await h.gateway.call(
        "propose_rollback",
        {
          service: "checkout",
          to_version: "v2.3.3",
          reason: "avisar a oncall@shop.test",
        },
        CONTEXT,
      );

      const proposal = [...h.proposals.proposals.values()][0];
      expect(JSON.stringify(proposal?.args)).not.toContain("oncall@shop.test");
    },
  },
  {
    id: "sin-aprobacion-no-se-ejecuta",
    regla: "una escritura sin aprobacion humana no se ejecuta",
    comprueba: async () => {
      const h = writeHarness();
      const proposalId = await propose(h);

      await expect(
        h.applier.applyApproved({
          proposalId,
          tenantId: CONTEXT.tenantId,
          approver: CONTEXT.userId,
          reason: null,
        }),
      ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });

      expect(h.executor.calls).toHaveLength(0);
      expect(h.effects.effects.size).toBe(0);
    },
  },
  {
    id: "propuesta-rechazada-no-se-ejecuta",
    regla: "una propuesta rechazada no se ejecuta",
    comprueba: async () => {
      const h = writeHarness();
      const proposalId = await propose(h);

      await h.applier.reject({
        proposalId,
        tenantId: CONTEXT.tenantId,
        approver: CONTEXT.userId,
        reason: "no es el momento",
      });

      await expect(
        h.applier.applyApproved({
          proposalId,
          tenantId: CONTEXT.tenantId,
          approver: CONTEXT.userId,
          reason: null,
        }),
      ).rejects.toMatchObject({ code: "conflict", statusCode: 409 });

      expect(h.executor.calls).toHaveLength(0);
    },
  },
  {
    id: "apply-idempotente-ante-rettento",
    regla: "repetir el apply no vuelve a ejecutar la escritura",
    comprueba: async () => {
      const h = writeHarness();
      const proposalId = await propose(h);

      const first = await h.applier.approve({
        proposalId,
        tenantId: CONTEXT.tenantId,
        approver: CONTEXT.userId,
        reason: "adelante",
      });
      const second = await h.applier.approve({
        proposalId,
        tenantId: CONTEXT.tenantId,
        approver: CONTEXT.userId,
        reason: "adelante",
      });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.effect.id).toBe(first.effect.id);
      expect(h.executor.calls).toHaveLength(1);
    },
  },
  {
    id: "apply-409-no-reintenta",
    regla: "un 409 queda registrado como conflicto y no se reintenta",
    comprueba: async () => {
      const h = writeHarness();
      h.executor.result = {
        effectId: "eff_conflict",
        status: "conflict",
        observedState: { version: "v2.3.4" },
        verified: false,
        durationMs: 7,
        evidence: ["el estado cambio antes de escribir (409)"],
      };

      const proposalId = await propose(h);
      const outcome = await h.applier.approve({
        proposalId,
        tenantId: CONTEXT.tenantId,
        approver: CONTEXT.userId,
        reason: null,
      });

      expect(outcome.effect.status).toBe("conflict");
      expect(outcome.effect.verified).toBe(false);
      expect(outcome.proposal.status).toBe("conflict");
      expect(outcome.effect.observedState).toMatchObject({ version: "v2.3.4" });
    },
  },
  {
    id: "apply-timeout-consulta-el-estado",
    regla: "un timeout se registra con el estado observado, sin asumir que no se aplico",
    comprueba: async () => {
      const h = writeHarness();
      h.executor.result = {
        effectId: "eff_timeout",
        status: "timeout",
        observedState: { version: "v2.3.3" },
        verified: false,
        durationMs: 30_000,
        evidence: ["la llamada al proveedor expiro; el estado se consulto"],
      };

      const proposalId = await propose(h);
      const outcome = await h.applier.approve({
        proposalId,
        tenantId: CONTEXT.tenantId,
        approver: CONTEXT.userId,
        reason: null,
      });

      expect(outcome.effect.status).toBe("timeout");
      expect(outcome.effect.verified).toBe(false);
      expect(outcome.effect.observedState).toMatchObject({ version: "v2.3.3" });
      expect(outcome.proposal.status).toBe("timeout");
    },
  },
  {
    id: "post-condicion-degradada",
    regla: "una escritura aplicada pero no verificada no se reporta como exito",
    comprueba: async () => {
      const h = writeHarness();
      h.executor.result = {
        effectId: "eff_degraded",
        status: "applied",
        observedState: { version: "v2.3.3", rollout_percent: 0 },
        verified: false,
        durationMs: 25_000,
        evidence: ["la post-condicion no se cumplio"],
      };

      const proposalId = await propose(h);
      const outcome = await h.applier.approve({
        proposalId,
        tenantId: CONTEXT.tenantId,
        approver: CONTEXT.userId,
        reason: null,
      });

      expect(outcome.effect.status).toBe("applied");
      expect(outcome.effect.verified).toBe(false);
      expect(outcome.proposal.status).toBe("degraded");
    },
  },
  {
    id: "apply-auditado-con-actor-humano",
    regla: "la decision humana y el efecto quedan auditados con su actor",
    comprueba: async () => {
      const h = writeHarness();
      const proposalId = await propose(h);
      await h.applier.approve({
        proposalId,
        tenantId: CONTEXT.tenantId,
        approver: CONTEXT.userId,
        reason: "adelante",
      });

      const actions = h.audit.entries.map((entry) => entry.action);
      expect(actions).toContain("proposal.created");
      expect(actions).toContain("proposal.approved");
      expect(actions).toContain("action.applied");

      const approval = h.audit.entries.find((entry) => entry.action === "proposal.approved");
      expect(approval?.actor).toBe(`user:${CONTEXT.userId}`);
    },
  },
  {
    id: "denegacion-auditada",
    regla: "una escritura denegada por falta de aprobacion queda auditada",
    comprueba: async () => {
      const h = writeHarness();
      const proposalId = await propose(h);

      await expect(
        h.applier.applyApproved({
          proposalId,
          tenantId: CONTEXT.tenantId,
          approver: CONTEXT.userId,
          reason: null,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      const denied = h.audit.entries.find((entry) => entry.action === "action.denied");
      expect(denied?.payload).toMatchObject({ reason: "approval_required" });
    },
  },
  {
    id: "presupuesto-antes-de-la-llamada",
    regla: "la reserva de presupuesto ocurre antes de llamar y se liquida despues",
    comprueba: async () => {
      const h = harness();
      const budget = new FakeBudget();
      const gateway = createToolGateway({
        transport: h.transport,
        allowedTools: ["list_services"],
        audit: h.audit,
        rateLimiter: h.rateLimiter,
        budget,
        budgetLimits: LIMITS,
        usageMeter: {
          estimate: () => ({ tokensIn: 10, tokensOut: 5, costCents: 3, wallMs: 0 }),
        },
        actor: ACTOR,
      });

      const outcome = await gateway.call("list_services", {}, CONTEXT);

      expect(h.calls).toEqual(["list_services"]);
      expect(budget.reserves).toHaveLength(1);
      expect(budget.reserves[0]?.estimate).toMatchObject({ costCents: 3 });
      expect(budget.settlements).toHaveLength(1);
      expect(outcome.usage).toMatchObject({ costCents: 3, tokensIn: 10 });
    },
  },
  {
    id: "presupuesto-rebasado-no-llama",
    regla: "si el presupuesto no alcanza, la tool no se ejecuta y queda auditado",
    comprueba: async () => {
      const h = harness();
      const budget = new FakeBudget();
      budget.deny = {
        reason: "budget_exceeded",
        dimension: "costCents",
        scope: "tenant",
        limit: 10,
        observed: 10,
        requested: 1,
      };
      const gateway = createToolGateway({
        transport: h.transport,
        allowedTools: ["list_services"],
        audit: h.audit,
        rateLimiter: h.rateLimiter,
        budget,
        budgetLimits: LIMITS,
        actor: ACTOR,
      });

      await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toMatchObject({
        code: "budget_exceeded",
        statusCode: 402,
      });
      expect(h.calls).toHaveLength(0);
      expect(budget.settlements).toHaveLength(0);
      expect(h.audit.entries.map((entry) => entry.action)).toEqual(["tool.call.denied"]);
      expect(h.audit.entries[0]?.payload).toMatchObject({ reason: "budget_exceeded" });
    },
  },
  {
    id: "presupuesto-se-liquida-si-la-tool-falla",
    regla: "una tool que falla no deja la reserva de presupuesto abierta",
    comprueba: async () => {
      const calls: string[] = [];
      const budget = new FakeBudget();
      const audit = new FakeAuditLog();
      const gateway = createToolGateway({
        transport: {
          async callTool(request) {
            calls.push(request.name);
            throw new Error("mcp no disponible");
          },
        },
        allowedTools: ["list_services"],
        audit,
        rateLimiter: new FakeRateLimiter(),
        budget,
        budgetLimits: LIMITS,
        actor: ACTOR,
      });

      await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toThrow(
        "mcp no disponible",
      );
      expect(calls).toHaveLength(1);
      expect(budget.settlements).toHaveLength(1);
    },
  },
  {
    id: "presupuesto-se-libera-si-el-audit-falla",
    regla: "si el audit no esta disponible, la tool no se llama y la reserva se libera",
    comprueba: async () => {
      const h = harness();
      const budget = new FakeBudget();
      h.audit.unavailable = true;
      const gateway = createToolGateway({
        transport: h.transport,
        allowedTools: ["list_services"],
        audit: h.audit,
        rateLimiter: h.rateLimiter,
        budget,
        budgetLimits: LIMITS,
        actor: ACTOR,
      });

      await expect(gateway.call("list_services", {}, CONTEXT)).rejects.toThrow(
        "audit no disponible",
      );
      expect(h.calls).toHaveLength(0);
      expect(budget.releases).toHaveLength(1);
    },
  },
];

describe("politicas del gateway", () => {
  it("cubre todas las reglas declaradas", () => {
    const ids = REGLAS.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(28);
  });

  for (const rule of REGLAS) {
    it(`${rule.id}: ${rule.regla}`, rule.comprueba);
  }
});
