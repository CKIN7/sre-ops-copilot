import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProposalSummary } from "../src/api/client.js";
import { ProposalCard } from "../src/components/ProposalCard.js";

/**
 * Tests de la tarjeta de aprobación (plan §11).
 *
 * Lo que se comprueba es la parte que decide una persona: ve el diff y el radio de
 * impacto, y al aprobar manda la razón que ha escrito. El botón llama al callback
 * con la razón; el `apply` real lo hace la API.
 */

const PROPOSAL: ProposalSummary = {
  proposal: {
    id: "11111111-1111-4111-8111-111111111111",
    approvalId: "22222222-2222-4222-8222-222222222222",
    tenantId: "33333333-3333-4333-8333-333333333333",
    kind: "rollback",
    tool: "propose_rollback",
    status: "pending_approval",
    risk: "alto",
    target: "checkout",
    args: { service: "checkout", to_version: "1.41.0", reason: "pico de 5xx" },
    diff: {
      kind: "rollback",
      service: "checkout",
      from_version: "1.42.0",
      to_version: "1.41.0",
      rollout_percent: 100,
      commit_sha: "abc1234",
      files_changed: 3,
    },
    blastRadius: {
      service: "checkout",
      tier: "critical",
      owner_team: "payments",
      dependents: ["api"],
      dependency_count: 1,
    },
    evidence: ["despliegue actual 1.42.0 (abc1234)"],
    idempotencyKey: "key",
    runId: null,
    toolCallId: null,
    createdAt: "2026-11-21T12:00:00.000Z",
    decidedAt: null,
    appliedAt: null,
  },
  approval: null,
  effect: null,
};

describe("ProposalCard", () => {
  it("enseña el diff, el radio de impacto y la evidencia", () => {
    render(
      <ProposalCard proposal={PROPOSAL} onApprove={vi.fn()} onReject={vi.fn()} />,
    );

    expect(screen.getByText("1.42.0")).toBeTruthy();
    expect(screen.getByText("1.41.0")).toBeTruthy();
    expect(screen.getByText("critical")).toBeTruthy();
    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.getByText(/despliegue actual 1.42.0/)).toBeTruthy();
  });

  it("aprueba con el motivo que escribió la persona", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn(async () => undefined);

    render(<ProposalCard proposal={PROPOSAL} onApprove={onApprove} onReject={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Aprobar y ejecutar" }));
    await user.type(
      screen.getByLabelText(/Motivo de la aprobación/),
      "el pico es real",
    );
    await user.click(screen.getByRole("button", { name: "Confirmar aprobación" }));

    expect(onApprove).toHaveBeenCalledWith(PROPOSAL.proposal.id, "el pico es real");
  });

  it("rechaza con el motivo y no llama a aprobar", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn(async () => undefined);
    const onReject = vi.fn(async () => undefined);

    render(<ProposalCard proposal={PROPOSAL} onApprove={onApprove} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: "Rechazar" }));
    await user.type(screen.getByLabelText(/Motivo del rechazo/), "no es el momento");
    await user.click(screen.getByRole("button", { name: "Confirmar rechazo" }));

    expect(onReject).toHaveBeenCalledWith(PROPOSAL.proposal.id, "no es el momento");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("una propuesta ya decidida no ofrece volver a decidir", () => {
    const decided: ProposalSummary = {
      ...PROPOSAL,
      proposal: { ...PROPOSAL.proposal, status: "applied" },
      approval: {
        id: "44444444-4444-4444-8444-444444444444",
        proposalId: PROPOSAL.proposal.id,
        tenantId: PROPOSAL.proposal.tenantId,
        approver: "user:55555555-5555-4555-8555-555555555555",
        decision: "approved",
        reason: "adelante",
        decidedAt: "2026-11-21T12:05:00.000Z",
      },
      effect: {
        id: "66666666-6666-4666-8666-666666666666",
        proposalId: PROPOSAL.proposal.id,
        tenantId: PROPOSAL.proposal.tenantId,
        idempotencyKey: "key",
        executor: "simulated",
        effectId: "eff_abc",
        status: "applied",
        verified: true,
        observedState: { version: "1.41.0" },
        evidence: ["post-condicion verificada"],
        durationMs: 12,
        errorCode: null,
        createdAt: "2026-11-21T12:05:00.000Z",
        appliedAt: "2026-11-21T12:05:00.000Z",
      },
    };

    render(<ProposalCard proposal={decided} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Aprobar y ejecutar" })).toBeNull();
    expect(screen.getByText(/aprobada por/)).toBeTruthy();
    expect(screen.getByText("verificado")).toBeTruthy();
  });

  it("marca como degradado un efecto aplicado pero no verificado", () => {
    const degraded: ProposalSummary = {
      ...PROPOSAL,
      proposal: { ...PROPOSAL.proposal, status: "degraded" },
      effect: {
        id: "77777777-7777-4777-8777-777777777777",
        proposalId: PROPOSAL.proposal.id,
        tenantId: PROPOSAL.proposal.tenantId,
        idempotencyKey: "key",
        executor: "simulated",
        effectId: "eff_abc",
        status: "applied",
        verified: false,
        observedState: { version: "1.41.0", rollout_percent: 0 },
        evidence: ["la post-condicion no se cumplio"],
        durationMs: 25_000,
        errorCode: null,
        createdAt: "2026-11-21T12:05:00.000Z",
        appliedAt: "2026-11-21T12:05:00.000Z",
      },
    };

    render(<ProposalCard proposal={degraded} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByText("sin verificar")).toBeTruthy();
  });
});
