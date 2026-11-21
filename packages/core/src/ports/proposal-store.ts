import type { ApprovalRecord, ProposalRecord } from "../domain/proposals.js";
import type {
  ProposalStatus,
  RiskLevel,
  WriteKind,
} from "../domain/write-tools.js";
import type { WriteToolName } from "../schemas/writes.js";

/**
 * Persistencia de las propuestas y de las aprobaciones (ADR-004).
 *
 * La propuesta es el plan que una tool `propose_*` calculó; la aprobación es el acto
 * humano. Están en tablas separadas porque tienen una relación 1:0..1: una propuesta
 * tiene como mucho una decisión, y esa decisión es terminal.
 *
 * La implementación (Drizzle/Postgres) vive en `apps/api/src/adapters`; el gateway solo
 * conoce esta interfaz (ADR-003, decisión 5).
 */

export type { ProposalStatus, RiskLevel } from "../domain/write-tools.js";
export type {
  ApprovalDecision,
  ApprovalRecord,
  ProposalRecord,
} from "../domain/proposals.js";

export interface CreateProposalInput {
  /** Id acuñado por la aplicación: el audit lo cita antes de que exista la fila. */
  id: string;
  /** Id de la aprobación, acuñado junto con la propuesta. */
  approvalId: string;
  tenantId: string;
  kind: WriteKind;
  tool: WriteToolName;
  risk: RiskLevel;
  target: string;
  args: unknown;
  diff: unknown;
  blastRadius: unknown;
  evidence: string[];
  idempotencyKey: string;
  runId: string | null;
  toolCallId: string | null;
}

export interface ListProposalsOptions {
  status?: ProposalStatus;
  /** Filtra por run: las propuestas que abrió un run concreto. */
  runId?: string;
  limit?: number;
}

export interface DecideApprovalInput {
  proposalId: string;
  tenantId: string;
  approver: string;
  decision: "approved" | "rejected";
  reason: string | null;
  decidedAt: string;
}

export interface ProposalStore {
  /**
   * Crea la propuesta o devuelve la que ya existe con la misma clave de
   * idempotencia. Nunca hay dos propuestas para la misma intención.
   */
  createProposal(input: CreateProposalInput): Promise<ProposalRecord>;
  getProposal(id: string, tenantId: string): Promise<ProposalRecord | null>;
  listProposals(tenantId: string, options?: ListProposalsOptions): Promise<ProposalRecord[]>;
  /** Registra la decisión. Si ya hay una, la devuelve sin cambiarla. */
  decideApproval(input: DecideApprovalInput): Promise<ApprovalRecord>;
  getApproval(proposalId: string): Promise<ApprovalRecord | null>;
  updateProposalStatus(
    proposalId: string,
    status: ProposalStatus,
    appliedAt: string | null,
  ): Promise<void>;
}
