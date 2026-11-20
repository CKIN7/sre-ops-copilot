/**
 * Audit append-only con hash chain (docs/plan.md §4.8, ADR-012).
 *
 * El puerto vive en `core` y la implementación en los adaptadores: el gateway solo
 * conoce esta interfaz (ADR-003), así que la política se prueba sin Postgres.
 */

/** Acciones auditadas. Deliberadamente cerradas: el audit es un contrato, no un log libre. */
export type AuditAction =
  | "tool.call.allowed"
  | "tool.call.denied"
  | "tool.call.error"
  | "tool.call.result";

export interface AuditEntry {
  tenantId: string;
  /** Quién actúa: `agent:<nombre>`. Nunca un email: la PII no se persiste. */
  actor: string;
  action: AuditAction;
  /** Qué se actúa: `<tool>#<runId>`. */
  target: string;
  /** Payload **ya redactado**. El adaptador guarda su hash, nunca el contenido. */
  payload: unknown;
}

export interface AuditRecord {
  id: string;
  hash: string;
  prevHash: string;
  createdAt: string;
}

export interface AuditChainVerification {
  /** `true` si toda la cadena recalcula y enlaza. */
  ok: boolean;
  /** Filas verificadas. */
  entries: number;
  /** Id de la primera fila que rompe la cadena; `null` si todo cuadra. */
  brokenAt: string | null;
  /** Motivo de la rotura; `null` si todo cuadra. */
  reason: string | null;
}

export interface AuditLog {
  /** Añade una entrada al final de la cadena y devuelve su huella. */
  append(entry: AuditEntry): Promise<AuditRecord>;
  /** Recorre la cadena y comprueba que nadie la reescribió. */
  verify(): Promise<AuditChainVerification>;
}
