import type {
  ActionApplier,
  ApplyOutcome,
  ApprovalRequest,
  RejectOutcome,
} from "@beacon/core/ports/action-applier";
import { trace, SpanStatusCode } from "@opentelemetry/api";

function tracer() {
  return trace.getTracer("beacon.gateway", "0.1.0");
}
import type { ActionExecutor, ActionResult } from "@beacon/core/ports/action-executor";
import type { AuditLog } from "@beacon/core/ports/audit-log";
import type { EffectLedger } from "@beacon/core/ports/effect-ledger";
import type {
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
} from "@beacon/core/ports/proposal-store";
import { effectIdFromKey, effectKey } from "@beacon/core/domain/idempotency";
import { parseDurationSeconds } from "@beacon/core/domain/duration";
import { AppError } from "@beacon/core/errors/app-error";
import { redactValue } from "@beacon/core/redaction/redact";

/**
 * Fase 2 de las escrituras en dos fases (ADR-004).
 *
 * Aquí vive la política que hace que una escritura no destructivo sea segura:
 *
 * 1. **Sin aprobación no hay ejecución.** La decisión se lee de la base, no del
 *    llamante: el `apply` no acepta un "sí" por parámetro.
 * 2. **El rettento no reejecuta.** El efecto se reserva con una clave única antes
 *    de tocar el mundo; si ya existe, se devuelve el guardado.
 * 3. **`409` y `timeout` no se reintentan.** Se registran con el estado observado
 *    para que alguien reconcilie.
 * 4. **La post-condición manda.** Un efecto aplicado pero no verificado deja la
 *    propuesta en `degraded`: nunca se reporta como éxito.
 */
export interface ActionApplierOptions {
  proposals: ProposalStore;
  effects: EffectLedger;
  executor: ActionExecutor;
  audit: AuditLog;
  /** Nombre del ejecutor; queda en la fila del efecto. */
  executorName: string;
  onError?: (error: unknown) => void;
  /** Reloj inyectable para los tests. */
  now?: () => number;
}

type Command =
  | { kind: "rollback"; command: Parameters<ActionExecutor["rollback"]>[0] }
  | { kind: "set_flag"; command: Parameters<ActionExecutor["setFlag"]>[0] }
  | { kind: "silence_alert"; command: Parameters<ActionExecutor["silenceAlert"]>[0] };

/**
 * Estado de la proposal a partir del resultado del ejecutor. `applied` sin
 * verificar es `degraded`: se aplicó, pero no sabemos si funcionó.
 */
function proposalStatusFor(result: ActionResult): ProposalStatus {
  switch (result.status) {
    case "applied":
      return result.verified ? "applied" : "degraded";
    case "noop":
      return "noop";
    case "conflict":
      return "conflict";
    case "timeout":
      return "timeout";
    case "partial":
      return "partial";
  }
}

/**
 * Comando del ejecutor a partir de los argumentos **persistidos** de la propuesta.
 *
 * Se usan los valores guardados, no los del pedido: son los redactados, que son
 * exactamente los que se aprueban y los que se ejecutan.
 */
function commandFor(proposal: ProposalRecord, idempotencyKey: string): Command {
  const args = (proposal.args ?? {}) as Record<string, unknown>;
  const reason = typeof args.reason === "string" ? args.reason : "";

  switch (proposal.kind) {
    case "rollback":
      return {
        kind: "rollback",
        command: {
          service: String(args.service ?? ""),
          toVersion: String(args.to_version ?? ""),
          reason,
          idempotencyKey,
        },
      };
    case "set_flag": {
      const value = args.value;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new AppError("internal", "the proposal has no usable flag value");
      }
      return {
        kind: "set_flag",
        command: {
          flag: String(args.flag ?? ""),
          value,
          reason,
          idempotencyKey,
        },
      };
    }
    case "silence_alert": {
      let durationSeconds: number;
      try {
        durationSeconds = parseDurationSeconds(String(args.duration ?? ""));
      } catch {
        throw new AppError("internal", "the proposal has no usable silence duration");
      }
      return {
        kind: "silence_alert",
        command: {
          alertId: String(args.alert_id ?? ""),
          durationSeconds,
          reason,
          idempotencyKey,
        },
      };
    }
  }
}

export function createActionApplier(options: ActionApplierOptions): ActionApplier {
  const now = options.now ?? (() => Date.now());

  const runExecutor = async (
    command: Command,
    proposal: ProposalRecord,
    idempotencyKey: string,
  ): Promise<ActionResult> => {
    return tracer().startActiveSpan(
      "action_apply",
      {
        attributes: {
          tenant_id: proposal.tenantId,
          run_id: proposal.runId ?? "",
          proposal_id: proposal.id,
          tool: proposal.tool,
          executor: options.executorName,
          idempotency_key: idempotencyKey,
        },
      },
      async (span) => {
        try {
          switch (command.kind) {
            case "rollback":
              return await options.executor.rollback(command.command);
            case "set_flag":
              return await options.executor.setFlag(command.command);
            case "silence_alert":
              return await options.executor.silenceAlert(command.command);
          }
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  };

  const appendAudit = async (
    action: "proposal.approved" | "proposal.rejected" | "action.applied" | "action.denied" | "action.replayed",
    request: ApprovalRequest,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await options.audit.append({
      tenantId: request.tenantId,
      actor: `user:${request.approver}`,
      action,
      target: `proposal#${request.proposalId}`,
      payload: redactValue(payload),
    });
  };

  const loadProposal = async (request: ApprovalRequest): Promise<ProposalRecord> => {
    const proposal = await options.proposals.getProposal(request.proposalId, request.tenantId);
    if (!proposal) {
      throw new AppError("not_found", "proposal not found", { statusCode: 404 });
    }
    return proposal;
  };

  const applyApproved = async (request: ApprovalRequest): Promise<ApplyOutcome> => {
    const proposal = await loadProposal(request);
    const approval = await options.proposals.getApproval(proposal.id);

    if (!approval) {
      await appendAudit("action.denied", request, {
        proposal_id: proposal.id,
        reason: "approval_required",
      });
      throw new AppError("forbidden", "the proposal has not been approved", {
        statusCode: 403,
      });
    }

    if (approval.decision === "rejected") {
      await appendAudit("action.denied", request, {
        proposal_id: proposal.id,
        reason: "rejected",
      });
      throw new AppError("conflict", "the proposal was rejected", { statusCode: 409 });
    }

    const key = effectKey(request.tenantId, proposal.id);
    const reservation = await options.effects.reserveEffect({
      proposalId: proposal.id,
      tenantId: request.tenantId,
      idempotencyKey: key,
      executor: options.executorName,
      effectId: effectIdFromKey(key),
    });

    if (!reservation.reserved) {
      // Reintento: el efecto ya existe y **no** se vuelve a ejecutar. Se devuelve
      // lo que quedó registrado la primera vez (ADR-004, decisión 5).
      await appendAudit("action.replayed", request, {
        proposal_id: proposal.id,
        effect_id: reservation.effect.effectId,
        status: reservation.effect.status,
        verified: reservation.effect.verified,
      });
      return {
        proposal,
        approval,
        effect: reservation.effect,
        replayed: true,
      };
    }

    const effect = reservation.effect;
    let result: ActionResult;

    try {
      const command = commandFor(proposal, key);
      result = await runExecutor(command, proposal, key);
    } catch (error) {
      // El efecto queda registrado como fallido: la escritura no se reintenta a
      // ciegas y quien lo mire ve que pasó.
      const appliedAt = new Date(now()).toISOString();
      await options.effects.completeEffect(effect.id, {
        status: "failed",
        verified: false,
        observedState: null,
        evidence: [],
        durationMs: 0,
        errorCode: error instanceof AppError ? error.code : "internal",
        appliedAt,
      });
      await options.proposals.updateProposalStatus(proposal.id, "failed", appliedAt);
      throw error;
    }

    const appliedAt = new Date(now()).toISOString();
    const completed = await options.effects.completeEffect(effect.id, {
      status: result.status,
      verified: result.verified,
      observedState: result.observedState,
      evidence: result.evidence,
      durationMs: result.durationMs,
      errorCode: null,
      appliedAt,
    });

    const status = proposalStatusFor(result);
    await options.proposals.updateProposalStatus(proposal.id, status, appliedAt);

    // El audit del resultado es best effort: la ejecución ya ocurrió y no se puede
    // deshacer. El audit de la decisión (`proposal.approved`) sí es previo y bloquea
    // la ejecución si falla.
    try {
      await appendAudit("action.applied", request, {
        proposal_id: proposal.id,
        effect_id: completed.effectId,
        executor: completed.executor,
        status: completed.status,
        verified: completed.verified,
        duration_ms: completed.durationMs,
        proposal_status: status,
      });
    } catch (error) {
      options.onError?.(error);
    }

    return {
      proposal: {
        ...proposal,
        status,
        decidedAt: approval.decidedAt,
        appliedAt,
      },
      approval,
      effect: completed,
      replayed: false,
    };
  };

  const approve = async (request: ApprovalRequest): Promise<ApplyOutcome> => {
    const proposal = await loadProposal(request);
    const decidedAt = new Date(now()).toISOString();

    const approval = await options.proposals.decideApproval({
      proposalId: proposal.id,
      tenantId: request.tenantId,
      approver: `user:${request.approver}`,
      decision: "approved",
      reason: request.reason,
      decidedAt,
    });

    // Falla cerrado: sin audit de la decisión, la escritura no se ejecuta.
    await appendAudit("proposal.approved", request, {
      proposal_id: proposal.id,
      approval_id: approval.id,
      approver: approval.approver,
      reason: request.reason,
    });

    return applyApproved(request);
  };

  const reject = async (request: ApprovalRequest): Promise<RejectOutcome> => {
    const proposal = await loadProposal(request);
    const decidedAt = new Date(now()).toISOString();

    const approval = await options.proposals.decideApproval({
      proposalId: proposal.id,
      tenantId: request.tenantId,
      approver: `user:${request.approver}`,
      decision: "rejected",
      reason: request.reason,
      decidedAt,
    });

    await options.proposals.updateProposalStatus(proposal.id, "rejected", null);

    try {
      await appendAudit("proposal.rejected", request, {
        proposal_id: proposal.id,
        approval_id: approval.id,
        approver: approval.approver,
        reason: request.reason,
      });
    } catch (error) {
      options.onError?.(error);
    }

    return { proposal: { ...proposal, status: "rejected", decidedAt }, approval };
  };

  return { approve, reject, applyApproved };
}
