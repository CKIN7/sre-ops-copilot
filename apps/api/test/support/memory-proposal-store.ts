import { randomUUID } from "node:crypto";

import type {
  ApprovalRecord,
  ProposalRecord,
} from "@beacon/core/domain/proposals";
import type {
  CreateProposalInput,
  DecideApprovalInput,
  ListProposalsOptions,
  ProposalStore,
} from "@beacon/core/ports/proposal-store";

/**
 * Proposal store en memoria para los tests de HTTP de la API.
 *
 * Reproduce las dos garantías de la tabla real: una propuesta por
 * `(tenant_id, idempotency_key)` y una decisión por propuesta.
 */
export class MemoryProposalStore implements ProposalStore {
  readonly proposals = new Map<string, ProposalRecord>();
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly #byKey = new Map<string, string>();

  async createProposal(input: CreateProposalInput): Promise<ProposalRecord> {
    const key = `${input.tenantId}|${input.idempotencyKey}`;
    const existingId = this.#byKey.get(key);
    const existing = existingId ? this.proposals.get(existingId) : undefined;
    if (existing) {
      return existing;
    }

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
      createdAt: "2026-11-21T12:00:00.000Z",
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
      .filter((proposal) => !options.status || proposal.status === options.status)
      .filter((proposal) => !options.runId || proposal.runId === options.runId);
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
  }

  /** Ajuda a los tests a sembrar una propuesta sin pasar por el gateway. */
  seed(input: Partial<ProposalRecord> & { tenantId: string }): ProposalRecord {
    const record: ProposalRecord = {
      id: input.id ?? randomUUID(),
      approvalId: input.approvalId ?? randomUUID(),
      tenantId: input.tenantId,
      kind: input.kind ?? "rollback",
      tool: input.tool ?? "propose_rollback",
      status: input.status ?? "pending_approval",
      risk: input.risk ?? "alto",
      target: input.target ?? "checkout",
      args: input.args ?? {},
      diff: input.diff ?? {},
      blastRadius: input.blastRadius ?? {},
      evidence: input.evidence ?? [],
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      runId: input.runId ?? null,
      toolCallId: input.toolCallId ?? null,
      createdAt: input.createdAt ?? "2026-11-21T12:00:00.000Z",
      decidedAt: input.decidedAt ?? null,
      appliedAt: input.appliedAt ?? null,
    };
    this.proposals.set(record.id, record);
    this.#byKey.set(`${record.tenantId}|${record.idempotencyKey}`, record.id);
    return record;
  }
}
