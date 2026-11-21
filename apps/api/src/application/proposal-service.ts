import type { Principal } from "@beacon/core/domain/principal";
import type { ProposalStatus } from "@beacon/core/domain/write-tools";
import { AppError } from "@beacon/core/errors/app-error";
import type {
  ActionApplier,
  ApplyOutcome,
  RejectOutcome,
} from "@beacon/core/ports/action-applier";
import type {
  ListProposalsOptions,
  ProposalRecord,
  ProposalStore,
} from "@beacon/core/ports/proposal-store";
import {
  WRITE_TOOL_NAMES,
  proposalResultSchema,
  type WriteToolName,
} from "@beacon/core/schemas/writes";

import type { AgentBinding } from "./principal-directory.js";
import type { GatewayFactory } from "./run-service.js";

/** Lo que devuelve el gateway cuando la tool es de escritura. */
export type ProposalResult = {
  proposal_id: string;
  approval_id: string;
  status: ProposalStatus;
  plan: unknown;
};

export interface ProposalServiceDeps {
  store: ProposalStore;
  applier: ActionApplier;
  createGateway: GatewayFactory;
}

export interface ProposeCommand {
  principal: Principal;
  agent: AgentBinding;
  tool: string;
  args: unknown;
}

/**
 * Caso de uso de las propuestas (ADR-004).
 *
 * Proponer es pasar por el gateway como cualquier otra tool: allowlist, validación,
 * rate limit, redacción y audit. Lo que devuelve la tool `propose_*` es un plan; el
 * gateway lo persiste como propuesta y acuña el `approval_id`.
 *
 * Aprobar y rechazar son actos humanos: el que decide es el usuario resuelto en el
 * borde autenticado, y su id es lo que queda en el registro.
 */
export class ProposalService {
  readonly #deps: ProposalServiceDeps;

  constructor(deps: ProposalServiceDeps) {
    this.#deps = deps;
  }

  async propose(command: ProposeCommand): Promise<ProposalResult> {
    if (!(WRITE_TOOL_NAMES as readonly string[]).includes(command.tool)) {
      throw new AppError("invalid_input", `not a write tool: ${command.tool}`, {
        statusCode: 400,
      });
    }

    const gateway = this.#deps.createGateway(command.agent);
    const outcome = await gateway.call(
      command.tool as WriteToolName,
      command.args,
      {
        tenantId: command.principal.tenantId,
        userId: command.principal.userId,
        agentId: command.principal.agentId,
        // Una propuesta puede abrirla un operador fuera de un run.
        runId: null,
        stepIdx: 0,
      },
    );

    const parsed = proposalResultSchema.safeParse(outcome.result);
    if (!parsed.success) {
      throw new AppError("upstream_error", "the write tool returned no proposal", {
        statusCode: 502,
        details: parsed.error.issues,
      });
    }

    return parsed.data as ProposalResult;
  }

  async list(
    tenantId: string,
    options?: ListProposalsOptions,
  ): Promise<ProposalRecord[]> {
    return this.#deps.store.listProposals(tenantId, options);
  }

  async get(id: string, tenantId: string): Promise<ProposalRecord> {
    const proposal = await this.#deps.store.getProposal(id, tenantId);
    if (!proposal) {
      throw new AppError("not_found", "proposal not found", { statusCode: 404 });
    }
    return proposal;
  }

  async approve(command: {
    principal: Principal;
    proposalId: string;
    reason: string | null;
  }): Promise<ApplyOutcome> {
    return this.#deps.applier.approve({
      proposalId: command.proposalId,
      tenantId: command.principal.tenantId,
      approver: command.principal.userId,
      reason: command.reason,
    });
  }

  async reject(command: {
    principal: Principal;
    proposalId: string;
    reason: string | null;
  }): Promise<RejectOutcome> {
    return this.#deps.applier.reject({
      proposalId: command.proposalId,
      tenantId: command.principal.tenantId,
      approver: command.principal.userId,
      reason: command.reason,
    });
  }
}
