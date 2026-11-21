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
 * Lo que se guarda es lo redactado, y lo que se ejecuta son esos mismos valores:
 * una propuesta no puede decir una cosa y hacer otra.
 *
 * Si el audit falla, la llamada falla y la propuesta se queda pendiente: sin una
 * aprobación no se ejecuta nada, así que una propuesta sin auditar no es una vía
 * libre para escribir. La fase que sí es peligrosa (el `apply`) tiene su propio
 * audit previo y bloqueante.
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
        toolCallId: context.toolCallId ?? null,
      };

      // La propuesta se persiste antes de auditarla: si la intención ya se propuso,
      // la fila que ya existe manda, y su `id` es el que hay que citar. Auditar
      // antes citaría un id fantasma en el reintento.
      const proposal = await options.proposals.createProposal(input);

      await options.audit.append({
        tenantId: context.tenantId,
        actor: options.actor,
        action: "proposal.created",
        target: `${tool}#${context.runId ?? "no-run"}`,
        payload: redactValue({
          proposal_id: proposal.id,
          approval_id: proposal.approvalId,
          kind,
          risk: plan.risk,
          target: plan.target,
          idempotency_key: key,
        }),
      });

      return proposal;
    },
  };
}
