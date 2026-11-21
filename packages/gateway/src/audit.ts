import type { AuditAction, AuditEntry } from "@beacon/core/ports/audit-log";
import { redactValue } from "@beacon/core/redaction/redact";

/**
 * Construcción de las entradas de audit del gateway (docs/plan.md §4.7 y §4.8).
 *
 * Aquí se redacta: el payload que sale hacia `audit_log` lleva los marcadores
 * (`[redacted:email]`, `[redacted:token]`, …) y solo su hash se persiste. La redacción
 * vive en `core` y es la única del repo (ADR-010), para que no haya dos definiciones
 * de "secreto" que se desincronicen.
 */

export interface AuditEntryInput {
  tenantId: string;
  /** `agent:<nombre>`; nunca un email: la PII no se persiste. */
  actor: string;
  action: AuditAction;
  tool: string;
  /** `null` = llamada fuera de un run (una propuesta abierta desde la API). */
  runId: string | null;
  userId: string;
  stepIdx: number;
  /** Campos sueltos que se mezclan con `user_id` y `step_idx` en el payload. */
  payload: Record<string, unknown>;
}

/** Objetivo de la entrada: qué se actuó, en qué run. */
export function auditTarget(tool: string, runId: string | null): string {
  return `${tool}#${runId ?? "no-run"}`;
}

/** Entrada de audit con el payload ya redactado. */
export function buildAuditEntry(input: AuditEntryInput): AuditEntry {
  return {
    tenantId: input.tenantId,
    actor: input.actor,
    action: input.action,
    target: auditTarget(input.tool, input.runId),
    payload: redactValue({
      user_id: input.userId,
      step_idx: input.stepIdx,
      ...input.payload,
    }),
  };
}
