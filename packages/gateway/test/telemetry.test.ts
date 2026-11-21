import type { ToolCallContext } from "@beacon/core/ports/tool-gateway";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";

import { createActionApplier, createToolGateway } from "../src/gateway.js";
import { FakeAuditLog } from "./support/fake-audit.js";
import { FakeEffectLedger } from "./support/fake-effect-ledger.js";
import { FakeExecutor } from "./support/fake-executor.js";
import { FakeProposalStore } from "./support/fake-proposal-store.js";
import { FakeRateLimiter } from "./support/fake-rate-limiter.js";

const CONTEXT: ToolCallContext = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  stepIdx: 1,
};

const PLAN = {
  kind: "rollback",
  target: "checkout",
  risk: "alto",
  summary: "rollback de checkout",
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
    dependents: [],
    dependency_count: 0,
  },
  evidence: ["despliegue actual"],
};

/**
 * OTel verificable sin collector (docs/plan.md §10).
 *
 * El tracer provider vive en el test y exporta a memoria. La instrumentacion de
 * produccion usa la API de OTel: si no hay provider, los spans son no-op y no
 * requieren red. Aqui se demuestra que `action_apply` lleva los atributos del plan.
 */
describe("telemetria del gateway", () => {
  it("emite un span action_apply con run, tenant, tool y executor", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    const audit = new FakeAuditLog();
    const proposals = new FakeProposalStore();
    const effects = new FakeEffectLedger();
    const executor = new FakeExecutor();

    const gateway = createToolGateway({
      transport: {
        async callTool() {
          return PLAN;
        },
      },
      allowedTools: ["propose_rollback"],
      audit,
      rateLimiter: new FakeRateLimiter(),
      actor: "agent:test",
      proposals,
    });
    const applier = createActionApplier({
      proposals,
      effects,
      executor,
      audit,
      executorName: "simulated",
    });

    const proposed = await gateway.call(
      "propose_rollback",
      { service: "checkout", to_version: "v2.3.3", reason: "pico de 5xx" },
      CONTEXT,
    );
    const proposalId = (proposed.result as { proposal_id: string }).proposal_id;

    await applier.approve({
      proposalId,
      tenantId: CONTEXT.tenantId,
      approver: CONTEXT.userId,
      reason: "adelante",
    });

    const spans = exporter.getFinishedSpans();
    const action = spans.find((span) => span.name === "action_apply");
    expect(action).toBeDefined();
    expect(action?.attributes).toMatchObject({
      tenant_id: CONTEXT.tenantId,
      run_id: CONTEXT.runId,
      tool: "propose_rollback",
      executor: "simulated",
    });
    expect(action?.attributes.proposal_id).toBe(proposalId);

    await provider.shutdown();
  });
});
