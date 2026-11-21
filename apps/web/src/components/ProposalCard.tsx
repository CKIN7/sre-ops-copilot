import { useState } from "react";

import type { ProposalSummary } from "../api/client.js";
import { StatusBadge } from "./StatusBadge.js";

/**
 * Tarjeta de una propuesta (plan §11: modal de aprobación).
 *
 * Muestra lo que un humano necesita para decidir: el diff, a quién alcanza el
 * cambio, la evidencia y el motivo. Los botones de aprobar y rechazar exigen un
 * motivo: la decisión queda en el registro de auditoría.
 *
 * Aprobar **ejecuta** la escritura (ADR-004): la decisión y el apply son la misma
 * llamada, y el efecto es idempotente, así que un doble clic no escribe dos veces.
 */
export interface ProposalCardProps {
  proposal: ProposalSummary;
  onApprove: (id: string, reason: string | null) => Promise<void>;
  onReject: (id: string, reason: string | null) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function RiskBadge({ risk }: { risk: string }) {
  const tone =
    risk === "alto" ? "text-rose-300" : risk === "medio" ? "text-amber-300" : "text-slate-300";
  return <span className={`text-xs font-semibold uppercase ${tone}`}>riesgo {risk}</span>;
}

export function ProposalCard({
  proposal,
  onApprove,
  onReject,
  busy = false,
  error = null,
}: ProposalCardProps) {
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");

  const { proposal: record, approval, effect } = proposal;
  const diff = asRecord(record.diff);
  const blast = asRecord(record.blastRadius);
  const dependents = Array.isArray(blast.dependents) ? blast.dependents : [];
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  const args = asRecord(record.args);

  const decided = approval !== null;
  const pending = record.status === "pending_approval";

  const submit = async () => {
    const text = reason.trim();
    if (decision === "approve") {
      await onApprove(record.id, text.length > 0 ? text : null);
    } else if (decision === "reject") {
      await onReject(record.id, text.length > 0 ? text : null);
    }
    setDecision(null);
    setReason("");
  };

  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-slate-100">
          {record.tool}
          <span className="ml-2 font-normal text-slate-400">→ {record.target}</span>
        </h3>
        <RiskBadge risk={record.risk} />
        <StatusBadge status={record.status} />
        {effect && effect.verified === false && record.status !== "pending_approval" && (
          <StatusBadge status="degraded" label="sin verificar" />
        )}
      </header>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Diff
          </h4>
          <dl className="mt-1 space-y-1 text-xs">
            {Object.entries(diff)
              .filter(([key]) => key !== "kind")
              .map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="w-32 shrink-0 text-slate-500">{key}</dt>
                  <dd className="break-all text-slate-200">{String(value)}</dd>
                </div>
              ))}
          </dl>
          {typeof args.reason === "string" && (
            <p className="mt-2 text-xs text-slate-400">motivo: {args.reason}</p>
          )}
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Radio de impacto
          </h4>
          <dl className="mt-1 space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 text-slate-500">servicio</dt>
              <dd className="text-slate-200">{String(blast.service ?? record.target)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 text-slate-500">tier</dt>
              <dd className="text-slate-200">{String(blast.tier ?? "-")}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 text-slate-500">equipo</dt>
              <dd className="text-slate-200">{String(blast.owner_team ?? "-")}</dd>
            </div>
          </dl>
          {dependents.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {dependents.map((dependent) => (
                <span
                  key={String(dependent)}
                  className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300"
                >
                  {String(dependent)}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>

      {evidence.length > 0 && (
        <section className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Evidencia
          </h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-300">
            {evidence.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {approval && (
        <section className="mt-3 rounded-lg bg-slate-950/60 p-3 text-xs">
          <h4 className="font-semibold uppercase tracking-wide text-slate-500">Decisión</h4>
          <p className="mt-1 text-slate-200">
            {approval.decision === "approved" ? "aprobada" : "rechazada"} por{" "}
            <span className="font-mono">{approval.approver}</span> el {approval.decidedAt}
          </p>
          {approval.reason && <p className="mt-1 text-slate-400">motivo: {approval.reason}</p>}
          {effect && (
            <p className="mt-2 text-slate-300">
              efecto <StatusBadge status={effect.status} />{" "}
              <span className="text-slate-400">
                {effect.verified ? "verificado" : "sin verificar"}
              </span>{" "}
              <span className="text-slate-400">· {effect.durationMs} ms</span>
            </p>
          )}
        </section>
      )}

      {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}

      {pending && !decided && (
        <footer className="mt-4 border-t border-slate-800 pt-3">
          {decision === null && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDecision("approve")}
                disabled={busy}
                className="rounded-md bg-emerald-600/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                Aprobar y ejecutar
              </button>
              <button
                type="button"
                onClick={() => setDecision("reject")}
                disabled={busy}
                className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-100 hover:bg-slate-600 disabled:opacity-50"
              >
                Rechazar
              </button>
            </div>
          )}

          {decision !== null && (
            <div className="space-y-2">
              <label className="block text-xs text-slate-400" htmlFor={`reason-${record.id}`}>
                {decision === "approve"
                  ? "Motivo de la aprobación (queda en la auditoría)"
                  : "Motivo del rechazo (queda en la auditoría)"}
              </label>
              <textarea
                id={`reason-${record.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-slate-500"
                placeholder="por ejemplo: el pico es real, adelante"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${
                    decision === "approve" ? "bg-emerald-600/80 hover:bg-emerald-600" : "bg-rose-700/80 hover:bg-rose-700"
                  }`}
                >
                  {busy
                    ? "working…"
                    : decision === "approve"
                      ? "Confirmar aprobación"
                      : "Confirmar rechazo"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDecision(null);
                    setReason("");
                  }}
                  disabled={busy}
                  className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </footer>
      )}
    </article>
  );
}
