import type {
  ApprovalRecord,
  CreateProposalInput,
  DecideApprovalInput,
  ListProposalsOptions,
  ProposalRecord,
  ProposalStore,
} from "@beacon/core/ports/proposal-store";

/**
 * `ProposalStore` en memoria para los tests del gateway.
 *
 * Reproduce la idempotencia de la tabla real: una propuesta por
 * `(tenant_id, idempotency_key)` y una decisión por propuesta.
 */
export class FakeProposalStore implements ProposalStore {
  readonly proposals = new Map<string, ProposalRecord>();
  readonly approvals = new Map<string, ApprovalRecord>();
  /** Clave `tenant|idempotency_key` -> id de la propuesta. */
  readonly #byKey = new Map<string, string>();
  #sequence = 0;

  async createProposal(input: CreateProposalInput): Promise<ProposalRecord> {
    const key = `${input.tenantId}|${input.idempotencyKey}`;
    const existingId = this.#byKey.get(key);
    if (existingId) {
      const existing = this.proposals.get(existingId);
      if (existing) {
        return existing;
      }
    }

    this.#sequence += 1;
    const record: ProposalRecord = {
      id: input.id,
      approvalId: input.approvalId,
      tenantId: input.tenantId,
      kind: input.kind,
      tool: input.tool,
      status: "pending_approval",
      risk: input.risk,
      target: input.target,
      args: input.args,
      diff: input.diff,
      blastRadius: input.blastRadius,
      evidence: input.evidence,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      toolCallId: input.toolCallId,
      createdAt: `2026-11-21T12:00:0${this.#sequence}.000Z`,
      decidedAt: null,
      appliedAt: null,
    };

    this.proposals.set(record.id, record);
    this.#byKey.set(key, record.id);
    return record;
  }

  async getProposal(id: string, tenantId: string): Promise<ProposalRecord | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) {
      return null;
    }
    return proposal;
  }

  async listProposals(
    tenantId: string,
    options: ListProposalsOptions = {},
  ): Promise<ProposalRecord[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.tenantId === tenantId)
      .filter((proposal) => !options.status || proposal.status === options.status);
  }

  async decideApproval(input: DecideApprovalInput): Promise<ApprovalRecord> {
    const existing = this.approvals.get(input.proposalId);
    if (existing) {
      return existing;
    }

    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) {
      throw new Error(`unknown proposal: ${input.proposalId}`);
    }

    const record: ApprovalRecord = {
      id: proposal.approvalId,
      proposalId: input.proposalId,
      tenantId: input.tenantId,
      approver: input.approver,
      decision: input.decision,
      reason: input.reason,
      decidedAt: input.decidedAt,
    };

    this.approvals.set(input.proposalId, record);
    return record;
  }

  async getApproval(proposalId: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(proposalId) ?? null;
  }

  async updateProposalStatus(
    proposalId: string,
    status: ProposalRecord["status"],
    appliedAt: string | null,
  ): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`unknown proposal: ${proposalId}`);
    }
    proposal.status = status;
    proposal.appliedAt = appliedAt;
    if (status !== "pending_approval") {
      proposal.decidedAt = proposal.decidedAt ?? "2026-11-21T12:00:00.000Z";
    }
  }
}
