import type {
  AuditChainVerification,
  AuditEntry,
  AuditLog,
  AuditRecord,
} from "@beacon/core/ports/audit-log";

/** Audit en memoria: guarda las entradas para comprobar redaccion e invariantes. */
export class EvalAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<AuditRecord> {
    this.entries.push(entry);
    return {
      id: String(this.entries.length),
      hash: `hash-${this.entries.length}`,
      prevHash: this.entries.length === 1 ? "genesis" : `hash-${this.entries.length - 1}`,
      createdAt: "2026-11-21T12:00:00.000Z",
    };
  }

  async verify(): Promise<AuditChainVerification> {
    return { ok: true, entries: this.entries.length, brokenAt: null, reason: null };
  }
}
