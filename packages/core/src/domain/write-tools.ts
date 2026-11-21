/**
 * Hechos y límites de las tools de escritura (docs/plan.md §3.4 y §6).
 *
 * Igual que `read-tools.ts`, viven en `core` para que gateway, servidor MCP, API y
 * evals apliquen la misma semántica: el modelo no puede inventar el riesgo de una
 * acción ni pedir un silencio de una semana.
 */

/** Qué se propone. Es el discriminante del diff y del comando del ejecutor. */
export const WRITE_KINDS = ["rollback", "set_flag", "silence_alert"] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];

/** Riesgo de la acción. `silence_alert` es de riesgo medio: tapa una señal, no rompe
 * el servicio. Todas las escrituras, sin embargo, exigen aprobación humana: el
 * riesgo modula la atención que pide, no la exigencia de un humano (ADR-004).
 */
export const RISK_LEVELS = ["alto", "medio", "bajo"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Estados de una propuesta. `pending_approval` es el normal; el resto son lo que
 * pasó con ella: aprobada y ejecutada, rechazada, en conflicto, a medias o
 * degradada por no verificar la post-condición.
 */
export const PROPOSAL_STATUSES = [
  "pending_approval",
  "approved",
  "rejected",
  "applied",
  "noop",
  "conflict",
  "timeout",
  "partial",
  "degraded",
  "failed",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** `propose_silence_alert`: 24 h como máximo. */
export const MAX_SILENCE_SECONDS = 24 * 3600;

/** A partir de una hora el riesgo del silencio sube a medio (plan §3.4). */
export const MEDIUM_RISK_SILENCE_SECONDS = 3600;

/** El motivo viaja al audit y a la proposal: acotado para que no sea un texto sin fin. */
export const MAX_REASON_LENGTH = 500;

/** Tope del valor de una flag, sea lo que sea. */
export const MAX_FLAG_VALUE_LENGTH = 120;
