import type { Principal } from "@beacon/core/domain/principal";
import type { ProposalDetail } from "@beacon/core/domain/proposals";
import type { ProposalStatus } from "@beacon/core/domain/write-tools";
import { AppError } from "@beacon/core/errors/app-error";
import type {
  ActionApplier,
  ApplyOutcome,
  RejectOutcome,
} from "@beacon/core/ports/action-applier";
import type { DemoSessionStore } from "@beacon/core/ports/demo-session";
import type { EffectLedger } from "@beacon/core/ports/effect-ledger";
import type {
  ListProposalsOptions,
  ProposalRecord,
  ProposalStore,
} from "@beacon/core/ports/proposal-store";
import type { RunStore } from "@beacon/core/ports/run-store";
import {
  WRITE_TOOL_NAMES,
  proposalResultSchema,
  type WriteToolName,
} from "@beacon/core/schemas/writes";

import type { AgentBinding } from "./principal-directory.js";
import type { DemoRequest, GatewayFactory } from "./run-service.js";

/** Lo que devuelve el gateway cuando la tool es de escritura. */
export type ProposalResult = {
  proposal_id: string;
  approval_id: string;
  status: ProposalStatus;
  plan: unknown;
};

export interface ProposalServiceDeps {
  store: ProposalStore;
  effects: EffectLedger;
  runs: RunStore;
  applier: ActionApplier;
  createGateway: GatewayFactory;
  /** Presente solo en DEMO_MODE: el breaker bloquea el apply. */
  demoSessions?: DemoSessionStore;
}

export interface ProposeCommand {
  principal: Principal;
  agent: AgentBinding;
  tool: string;
  args: unknown;
  /**
   * Run al que se ancla la propuesta. `null` = propuesta suelta (un operador la
   * abre sin run). El run se valida contra el tenant: no se cuelga de otro.
   */
  runId?: string | null;
  /** Solo en DEMO_MODE. */
  demo?: DemoRequest;
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

    const runId = command.runId ?? null;
    if (runId !== null) {
      const run = await this.#deps.runs.getRun(runId, command.principal.tenantId);
      if (!run) {
        throw new AppError("not_found", "run not found", { statusCode: 404 });
      }
    }

    const gateway = this.#deps.createGateway(command.agent, command.demo);
    const outcome = await gateway.call(
      command.tool as WriteToolName,
      command.args,
      {
        tenantId: command.principal.tenantId,
        userId: command.principal.userId,
        agentId: command.principal.agentId,
        // Una propuesta puede abrirla un operador fuera de un run.
        runId,
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

  /**
   * Las propuestas con su decisión y su efecto.
   *
   * Es lo que devuelve la API: la UI necesita las tres cosas juntas para pintar la
   * cola de decisiones (qué se propone, quién lo decidió y qué pasó al aplicarlo).
   */
  async listDetails(
    tenantId: string,
    options?: ListProposalsOptions,
  ): Promise<ProposalDetail[]> {
    const proposals = await this.#deps.store.listProposals(tenantId, options);
    return Promise.all(proposals.map((proposal) => this.#detail(proposal)));
  }

  /**
   * Las propuestas de un run, cada una con su decisión y su efecto. Es lo que la
   * UI cuelga de la timeline para mostrar que un `apply` quedó `applied` o
   * `degraded` (plan §11).
   */
  async forRun(runId: string, tenantId: string): Promise<ProposalDetail[]> {
    const proposals = await this.#deps.store.listProposals(tenantId, { runId });
    return Promise.all(proposals.map((proposal) => this.#detail(proposal)));
  }

  /** Una propuesta con su decisión y su efecto. */
  async detail(id: string, tenantId: string): Promise<ProposalDetail> {
    const proposal = await this.#deps.store.getProposal(id, tenantId);
    if (!proposal) {
      throw new AppError("not_found", "proposal not found", { statusCode: 404 });
    }
    return this.#detail(proposal);
  }

  async #detail(proposal: ProposalRecord): Promise<ProposalDetail> {
    const [approval, effect] = await Promise.all([
      this.#deps.store.getApproval(proposal.id),
      this.#deps.effects.getEffectForProposal(proposal.id),
    ]);
    return { proposal, approval, effect };
  }

  async approve(command: {
    principal: Principal;
    proposalId: string;
    reason: string | null;
  }): Promise<ApplyOutcome> {
    if (this.#deps.demoSessions && (await this.#deps.demoSessions.isReplayOnly())) {
      throw new AppError("forbidden", "REPLAY_ONLY: no se ejecutan escrituras", {
        statusCode: 403,
        details: { reason: "replay_only" },
      });
    }
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
