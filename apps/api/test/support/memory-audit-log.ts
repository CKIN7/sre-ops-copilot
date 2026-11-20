import type {
  AuditChainVerification,
  AuditEntry,
  AuditLog,
  AuditRecord,
} from "@beacon/core/ports/audit-log";

/** Audit en memoria para los tests de la API: guarda las entradas y las devuelve. */
export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<AuditRecord> {
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
