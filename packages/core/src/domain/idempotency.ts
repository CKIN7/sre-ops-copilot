import { createHash } from "node:crypto";

import { stableStringify } from "./json.js";
import type { WriteKind } from "./write-tools.js";

/**
 * Claves de idempotencia de las escrituras (ADR-004 decisiones 2 y 5, ADR-005 decisión 6).
 *
 * Son **server-side**: se derivan del tenant y de la intención, nunca de lo que
 * diga el cliente. Así un rettento del mismo `propose_*` devuelve la misma
 * propuesta y un rettento del mismo `apply` devuelve el mismo efecto.
 *
 * Los argumentos que entran en la clave son los **redactados**: lo que se guarda y
 * lo que se ejecuta son los mismos valores, y la clave tiene que reflejar eso.
 */

/** Clave de una propuesta: mismo tenant, mismo tipo de escritura, mismos argumentos. */
export function proposalKey(tenantId: string, kind: WriteKind, args: unknown): string {
  return createHash("sha256")
    .update(stableStringify({ tenant_id: tenantId, kind, args }), "utf8")
    .digest("hex");
}

/** Clave de un efecto: una propuesta solo puede producir un efecto. */
export function effectKey(tenantId: string, proposalId: string): string {
  return createHash("sha256")
    .update(stableStringify({ tenant_id: tenantId, proposal_id: proposalId }), "utf8")
    .digest("hex");
}

/**
 * `effect_id` estable por clave de idempotencia. Lo deriva de la clave y no de un
 * UUID aleatorio: con la misma clave se reconcilia el mismo efecto.
 */
export function effectIdFromKey(idempotencyKey: string): string {
  return `eff_${idempotencyKey.slice(0, 32)}`;
}
