import type {
  ApprovalDecision,
  ApprovalRecord,
  CreateProposalInput,
  DecideApprovalInput,
  ListProposalsOptions,
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
} from "@beacon/core/ports/proposal-store";
import { AppError } from "@beacon/core/errors/app-error";
import { and, desc, eq } from "drizzle-orm";

import type { Database } from "./db.js";
import { approvals, proposals } from "./schema.js";

function toIso(value: Date): string;
function toIso(value: Date | null): string | null;
function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toProposal(row: typeof proposals.$inferSelect): ProposalRecord {
  return {
    id: row.id,
    approvalId: row.approvalId,
    tenantId: row.tenantId,
    kind: row.kind,
    tool: row.tool,
    status: row.status,
    risk: row.risk,
    target: row.target,
    args: row.argsRedacted,
    diff: row.diff,
    blastRadius: row.blastRadius,
    evidence: row.evidence,
    idempotencyKey: row.idempotencyKey,
    runId: row.runId,
    toolCallId: row.toolCallId,
    createdAt: row.createdAt.toISOString(),
    decidedAt: toIso(row.decidedAt),
    appliedAt: toIso(row.appliedAt),
  };
}

function toApproval(row: typeof approvals.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    proposalId: row.proposalId,
    tenantId: row.tenantId,
    approver: row.approver,
    decision: row.decision as ApprovalDecision,
    reason: row.reason,
    decidedAt: row.decidedAt.toISOString(),
  };
}

/**
 * Implementación Drizzle del puerto `ProposalStore` (ADR-004).
 *
 * **Idempotencia por restricción, no por lógica:** la propuesta se inserta con
 * `on conflict do nothing` sobre `(tenant_id, idempotency_key)`. Si la intención ya
 * se propuso, se devuelve la fila que ya existe —con su mismo `id` y su mismo
 * `approval_id`— en vez de abrir una segunda discusión.
 *
 * La decisión es terminal: `approvals` tiene una fila por propuesta y repetir la
 * aprobación devuelve la que ya hay.
 */
export class DrizzleProposalStore implements ProposalStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async createProposal(input: CreateProposalInput): Promise<ProposalRecord> {
    const inserted = await this.#db
      .insert(proposals)
      .values({
        id: input.id,
        approvalId: input.approvalId,
        tenantId: input.tenantId,
        kind: input.kind,
        tool: input.tool,
        status: "pending_approval",
        risk: input.risk,
        target: input.target,
        argsRedacted: input.args,
        diff: input.diff,
        blastRadius: input.blastRadius,
        evidence: input.evidence,
        idempotencyKey: input.idempotencyKey,
        runId: input.runId,
        toolCallId: input.toolCallId,
      })
      .onConflictDoNothing({ target: [proposals.tenantId, proposals.idempotencyKey] })
      .returning();

    const row = inserted[0];
    if (row) {
      return toProposal(row);
    }

    const existing = await this.#db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.tenantId, input.tenantId),
          eq(proposals.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    const found = existing[0];
    if (!found) {
      throw new AppError("internal", "proposal insert returned no row");
    }
    return toProposal(found);
  }

  async getProposal(id: string, tenantId: string): Promise<ProposalRecord | null> {
    const rows = await this.#db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, id), eq(proposals.tenantId, tenantId)))
      .limit(1);

    const row = rows[0];
    return row ? toProposal(row) : null;
  }

  async listProposals(
    tenantId: string,
    options: ListProposalsOptions = {},
  ): Promise<ProposalRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where = options.status
      ? and(eq(proposals.tenantId, tenantId), eq(proposals.status, options.status))
      : eq(proposals.tenantId, tenantId);

    const rows = await this.#db
      .select()
      .from(proposals)
      .where(where)
      .orderBy(desc(proposals.createdAt))
      .limit(limit);

    return rows.map(toProposal);
  }

  async decideApproval(input: DecideApprovalInput): Promise<ApprovalRecord> {
    const proposalRows = await this.#db
      .select({ approvalId: proposals.approvalId })
      .from(proposals)
      .where(
        and(eq(proposals.id, input.proposalId), eq(proposals.tenantId, input.tenantId)),
      )
      .limit(1);

    const proposal = proposalRows[0];
    if (!proposal) {
      throw new AppError("not_found", "proposal not found", { statusCode: 404 });
    }

    const inserted = await this.#db
      .insert(approvals)
      .values({
        id: proposal.approvalId,
        proposalId: input.proposalId,
        tenantId: input.tenantId,
        approver: input.approver,
        decision: input.decision,
        reason: input.reason,
        decidedAt: new Date(input.decidedAt),
      })
      .onConflictDoNothing({ target: approvals.proposalId })
      .returning();

    const row = inserted[0];
    if (row) {
      return toApproval(row);
    }

    const existing = await this.#db
      .select()
      .from(approvals)
      .where(eq(approvals.proposalId, input.proposalId))
      .limit(1);

    const found = existing[0];
    if (!found) {
      throw new AppError("internal", "approval insert returned no row");
    }
    return toApproval(found);
  }

  async getApproval(proposalId: string): Promise<ApprovalRecord | null> {
    const rows = await this.#db
      .select()
      .from(approvals)
      .where(eq(approvals.proposalId, proposalId))
      .limit(1);

    const row = rows[0];
    return row ? toApproval(row) : null;
  }

  async updateProposalStatus(
    proposalId: string,
    status: ProposalStatus,
    appliedAt: string | null,
  ): Promise<void> {
    await this.#db
      .update(proposals)
      .set({
        status,
        decidedAt: status === "pending_approval" ? undefined : new Date(),
        appliedAt: appliedAt === null ? null : new Date(appliedAt),
      })
      .where(eq(proposals.id, proposalId));
  }
}
