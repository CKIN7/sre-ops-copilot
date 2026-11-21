import { randomUUID } from "node:crypto";

import { proposalKey } from "@beacon/core/domain/idempotency";
import type { AuditLog } from "@beacon/core/ports/audit-log";
import type {
  CreateProposalInput,
  ProposalRecord,
  ProposalStore,
} from "@beacon/core/ports/proposal-store";
import type { ToolCallContext } from "@beacon/core/ports/tool-gateway";
import { redactValue } from "@beacon/core/redaction/redact";
import {
  WRITE_TOOL_KINDS,
  type ActionPlan,
  type WriteToolName,
} from "@beacon/core/schemas/writes";

/**
 * Fase 1 de las escrituras en dos fases (ADR-004).
 *
 * Una tool `propose_*` solo calcula: no muta ni persiste. Quien guarda el plan es
 * el gateway, porque es quien sabe el `tenant_id` (server-side) y quien decide qué
 * se audita.
 *
 * **Falla cerrado:** si el audit no está disponible, la propuesta no se persiste y
 * la llamada falla. Una propuesta sin registro es una vía libre para escribir.
 */
export interface ProposalWriterOptions {
  proposals: ProposalStore;
  audit: AuditLog;
  /** `agent:<nombre>`: quién propone. */
  actor: string;
  onError?: (error: unknown) => void;
}

export interface PersistProposalInput {
  context: ToolCallContext;
  tool: WriteToolName;
  /** Argumentos ya validados por el schema de la tool. */
  args: unknown;
  /** Plan que devolvió `mcp-ops`. */
  plan: ActionPlan;
}

export interface ProposalWriter {
  persist(input: PersistProposalInput): Promise<ProposalRecord>;
}

export function createProposalWriter(options: ProposalWriterOptions): ProposalWriter {
  return {
    async persist({ context, tool, args, plan }: PersistProposalInput): Promise<ProposalRecord> {
      const kind = WRITE_TOOL_KINDS[tool];

      // Lo que se guarda es lo redactado, y lo que se ejecuta son esos mismos
      // valores: una propuesta no puede decir una cosa y hacer otra.
      const redactedArgs = redactValue(args);
      const key = proposalKey(context.tenantId, kind, redactedArgs);

      const input: CreateProposalInput = {
        id: randomUUID(),
        approvalId: randomUUID(),
        tenantId: context.tenantId,
        kind,
        tool,
        risk: plan.risk,
        target: plan.target,
        args: redactedArgs,
        diff: redactValue(plan.diff),
        blastRadius: redactValue(plan.blast_radius),
        evidence: redactValue(plan.evidence) as string[],
        idempotencyKey: key,
        runId: context.runId,
        toolCallId: null,
      };

      // El audit va antes de la escritura: si no se puede auditar, no hay propuesta.
      await options.audit.append({
        tenantId: context.tenantId,
        actor: options.actor,
        action: "proposal.created",
        target: `${tool}#${context.runId ?? "no-run"}`,
        payload: redactValue({
          proposal_id: input.id,
          approval_id: input.approvalId,
          kind,
          risk: plan.risk,
          target: plan.target,
          idempotency_key: key,
        }),
      });

      return options.proposals.createProposal(input);
    },
  };
}
