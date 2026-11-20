import { createHash } from "node:crypto";

import { stableStringify } from "@beacon/core/domain/json";
import { AppError } from "@beacon/core/errors/app-error";
import type {
  AuditChainVerification,
  AuditEntry,
  AuditLog,
  AuditRecord,
} from "@beacon/core/ports/audit-log";
import { asc, desc, sql } from "drizzle-orm";

import type { Database } from "./db.js";
import { auditLog } from "./schema.js";

/** Hash de la primera fila: la cadena arranca aquí. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Lock global de la cadena de audit. Serializa las escrituras para que dos llamadas
 * concurrentes no lean el mismo `prev_hash` y bifurquen la cadena.
 */
const AUDIT_LOCK_KEY = 582_317_404;

export interface AuditHashInput {
  tenantId: string;
  actor: string;
  action: string;
  target: string;
  payloadHash: string;
  prevHash: string;
  createdAt: string;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Huella del payload canónico. El payload redactado nunca se persiste. */
export function auditPayloadHash(payload: unknown): string {
  return sha256Hex(stableStringify(payload ?? null));
}

/**
 * Hash de la fila completa. Se calcula sobre una serialización canónica (`stableStringify`)
 * y no sobre el JSON crudo: el verificador tiene que recalcular exactamente el mismo
 * valor a partir de lo que leyó de la tabla.
 */
export function auditRowHash(input: AuditHashInput): string {
  return sha256Hex(
    stableStringify({
      action: input.action,
      actor: input.actor,
      created_at: input.createdAt,
      payload_hash: input.payloadHash,
      prev_hash: input.prevHash,
      target: input.target,
      tenant_id: input.tenantId,
    }),
  );
}

/**
 * Implementación Drizzle del puerto `AuditLog` (docs/plan.md §4.8, ADR-012).
 *
 * Cada fila es un eslabón: guarda el hash de su payload, el hash de la fila anterior y
 * su propio hash. Alterar, insertar o borrar una fila rompe la cadena de forma
 * detectable; `verify()` la recorre y dice dónde deja de cuadrar.
 *
 * La tabla es append-only en la base (trigger `audit_log_no_update`), y además el
 * escritor serializa con un lock de sesión para que la cadena no se bifurque.
 */
export class DrizzleAuditLog implements AuditLog {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async append(entry: AuditEntry): Promise<AuditRecord> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY}::bigint)`);

      const [last] = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .orderBy(desc(auditLog.id))
        .limit(1);

      const prevHash = last?.hash ?? GENESIS_HASH;
      const createdAt = new Date();
      const payloadHash = auditPayloadHash(entry.payload);
      const hash = auditRowHash({
        tenantId: entry.tenantId,
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        payloadHash,
        prevHash,
        createdAt: createdAt.toISOString(),
      });

      const [row] = await tx
        .insert(auditLog)
        .values({
          tenantId: entry.tenantId,
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          payloadHash,
          prevHash,
          hash,
          createdAt,
        })
        .returning();

      if (!row) {
        throw new AppError("internal", "insert audit_log returned no row");
      }

      return {
        id: String(row.id),
        hash: row.hash,
        prevHash: row.prevHash,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async verify(): Promise<AuditChainVerification> {
    const rows = await this.#db.select().from(auditLog).orderBy(asc(auditLog.id));

    let prevHash = GENESIS_HASH;
    for (const row of rows) {
      if (row.prevHash !== prevHash) {
        return {
          ok: false,
          entries: rows.length,
          brokenAt: String(row.id),
          reason: "prev_hash no enlaza con la fila anterior",
        };
      }

      const expected = auditRowHash({
        tenantId: row.tenantId,
        actor: row.actor,
        action: row.action,
        target: row.target,
        payloadHash: row.payloadHash,
        prevHash: row.prevHash,
        createdAt: row.createdAt.toISOString(),
      });

      if (expected !== row.hash) {
        return {
          ok: false,
          entries: rows.length,
          brokenAt: String(row.id),
          reason: "el hash recalculado no coincide con el almacenado",
        };
      }

      prevHash = row.hash;
    }

    return { ok: true, entries: rows.length, brokenAt: null, reason: null };
  }
}
