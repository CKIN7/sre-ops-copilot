import type { EffectRecord } from "./effect-ledger.js";
import type { ApprovalRecord, ProposalRecord } from "./proposal-store.js";

/**
 * Fase 2 de las escrituras en dos fases (ADR-004).
 *
 * No es una tool: el modelo no la alcanza. Solo la llama el camino que ya pasó por
 * una aprobación humana, y el `apply` se apoya en el puerto `ActionExecutor` para
 * tocar el mundo.
 */
export interface ApprovalRequest {
  proposalId: string;
  tenantId: string;
  /** Id del usuario que aprueba, resuelto server-side. Nunca un email. */
  approver: string;
  reason: string | null;
}

export interface ApplyOutcome {
  proposal: ProposalRecord;
  approval: ApprovalRecord;
  effect: EffectRecord;
  /**
   * `true` = el efecto ya existía y se devolvió el guardado: la escritura **no** se
   * volvió a ejecutar. Es la respuesta a un rettento.
   */
  replayed: boolean;
}

export interface RejectOutcome {
  proposal: ProposalRecord;
  approval: ApprovalRecord;
}

export interface ActionApplier {
  /** Registra la decisión humana y ejecuta la escritura. */
  approve(request: ApprovalRequest): Promise<ApplyOutcome>;
  /** Registra la decisión humana y no ejecuta nada. */
  reject(request: ApprovalRequest): Promise<RejectOutcome>;
  /**
   * Ejecuta una propuesta **ya aprobada**. Es el camino que usará el worker que
   * reanude un run: ni el modelo ni la UI llegan aquí por su cuenta.
   */
  applyApproved(request: ApprovalRequest): Promise<ApplyOutcome>;
}
