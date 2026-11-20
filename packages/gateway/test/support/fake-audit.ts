import type {
  AuditChainVerification,
  AuditEntry,
  AuditLog,
  AuditRecord,
} from "@beacon/core/ports/audit-log";

/**
 * Audit en memoria para los tests del gateway.
 *
 * Guarda las entradas para poder afirmar sobre ellas y puede simular que la base no
 * está disponible, que es el caso en el que el gateway tiene que fallar cerrado.
 */
export class FakeAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  /** Si es `true`, `append` falla: el gateway no debe ejecutar la tool. */
  unavailable = false;

  async append(entry: AuditEntry): Promise<AuditRecord> {
    if (this.unavailable) {
      throw new Error("audit no disponible");
    }

    this.entries.push(entry);
    return {
      id: String(this.entries.length),
      hash: `hash-${this.entries.length}`,
      prevHash: this.entries.length === 1 ? "genesis" : `hash-${this.entries.length - 1}`,
      createdAt: new Date().toISOString(),
    };
  }

  async verify(): Promise<AuditChainVerification> {
    return { ok: true, entries: this.entries.length, brokenAt: null, reason: null };
  }
}
