import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Run, RunTimeline, TimelineStep, ToolCall } from "@beacon/core/domain/runs";

import type { ProposalSummary } from "../src/api/client.js";
import { TimelineView } from "../src/components/TimelineView.js";

/**
 * Tests de la timeline del run (plan §11).
 *
 * Lo que importa: que el estado del `apply` se vea. Una propuesta propuesta por el
 * modelo cuelga de su tool call; una abierta desde la API cuelga del run y se lista
 * aparte. Ninguna de las dos puede esconderse.
 */

const RUN: Run = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  status: "succeeded",
  trigger: "cli",
  goal: "Investiga el pico de errores 5xx en checkout",
  startedAt: "2026-11-21T12:00:00.000Z",
  endedAt: "2026-11-21T12:00:05.000Z",
  costCents: 0,
  tokensIn: 0,
  tokensOut: 0,
  errorCode: null,
  createdAt: "2026-11-21T12:00:00.000Z",
};

const TOOL_CALL: ToolCall = {
  id: "44444444-4444-4444-8444-444444444444",
  stepId: "55555555-5555-4555-8555-555555555555",
  tool: "propose_rollback",
  argsRedacted: { service: "checkout", to_version: "1.41.0" },
  resultHash: null,
  status: "ok",
  errorCode: null,
  idempotencyKey: null,
  createdAt: "2026-11-21T12:00:02.000Z",
  finishedAt: "2026-11-21T12:00:02.000Z",
};

const STEP: TimelineStep = {
  id: "55555555-5555-4555-8555-555555555555",
  runId: RUN.id,
  idx: 1,
  kind: "tool",
  model: null,
  promptVersion: null,
  latencyMs: 3,
  costCents: 0,
  payloadRef: null,
  createdAt: "2026-11-21T12:00:02.000Z",
  toolCalls: [TOOL_CALL],
};

function proposal(toolCallId: string | null): ProposalSummary {
  return {
    proposal: {
      id: "66666666-6666-4666-8666-666666666666",
      approvalId: "77777777-7777-4777-8777-777777777777",
      tenantId: RUN.tenantId,
      kind: "rollback",
      tool: "propose_rollback",
      status: "applied",
      risk: "alto",
      target: "checkout",
      args: { service: "checkout" },
      diff: { kind: "rollback" },
      blastRadius: { service: "checkout" },
      evidence: [],
      idempotencyKey: "key",
      runId: RUN.id,
      toolCallId,
      createdAt: "2026-11-21T12:00:00.000Z",
      decidedAt: "2026-11-21T12:00:03.000Z",
      appliedAt: "2026-11-21T12:00:03.000Z",
    },
    approval: {
      id: "77777777-7777-4777-8777-777777777777",
      proposalId: "66666666-6666-4666-8666-666666666666",
      tenantId: RUN.tenantId,
      approver: "user:88888888-8888-4888-8888-888888888888",
      decision: "approved",
      reason: "adelante",
      decidedAt: "2026-11-21T12:00:03.000Z",
    },
    effect: {
      id: "99999999-9999-4999-8999-999999999999",
      proposalId: "66666666-6666-4666-8666-666666666666",
      tenantId: RUN.tenantId,
      idempotencyKey: "key",
      executor: "simulated",
      effectId: "eff_abc",
      status: "applied",
      verified: true,
      observedState: { version: "1.41.0" },
      evidence: [],
      durationMs: 4,
      errorCode: null,
      createdAt: "2026-11-21T12:00:03.000Z",
      appliedAt: "2026-11-21T12:00:03.000Z",
    },
  };
}

function timeline(proposals: ProposalSummary[]): RunTimeline {
  return { run: RUN, steps: [STEP], proposals };
}

describe("TimelineView", () => {
  it("muestra el apply de la propuesta que cuelga de la tool call", () => {
    render(<TimelineView timeline={timeline([proposal(TOOL_CALL.id)])} />);

    expect(screen.getByText("apply:")).toBeTruthy();
    expect(screen.getAllByText("verificado").length).toBeGreaterThan(0);
  });

  it("lista aparte la propuesta abierta fuera de una tool call", () => {
    render(<TimelineView timeline={timeline([proposal(null)])} />);

    expect(screen.getByText("Escrituras del run")).toBeTruthy();
    expect(screen.queryByText("apply:")).toBeNull();
    expect(screen.getAllByText("verificado").length).toBeGreaterThan(0);
  });

  it("no inventa escrituras cuando el run no propone ninguna", () => {
    render(<TimelineView timeline={timeline([])} />);

    expect(screen.queryByText("Escrituras del run")).toBeNull();
  });
});
