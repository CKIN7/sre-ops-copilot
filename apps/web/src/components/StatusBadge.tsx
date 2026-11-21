/**
 * Colores por estado.
 *
 * El color dice una sola cosa: qué pasó. Verde es "funcionó y lo comprobamos",
 * ámbar es "hubo algo que mirar" y rojo es "falló". Un estado sin comprobar nunca
 * es verde (ADR-004, decisión 7).
 */
export type Tone = "ok" | "warn" | "bad" | "info" | "idle";

const TONES: Record<string, Tone> = {
  applied: "ok",
  succeeded: "ok",
  ok: "ok",
  approved: "ok",
  verified: "ok",

  degraded: "warn",
  partial: "warn",
  timeout: "warn",
  conflict: "warn",
  waiting_approval: "warn",
  pending_approval: "warn",
  running: "warn",

  failed: "bad",
  error: "bad",
  rejected: "bad",
  cancelled: "bad",

  queued: "info",
  pending: "info",
};

export function toneOf(status: string | null | undefined): Tone {
  if (!status) {
    return "idle";
  }
  return TONES[status] ?? "idle";
}

const CLASSES: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  bad: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  info: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  idle: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
};

export function toneClasses(tone: Tone): string {
  return CLASSES[tone];
}

export function StatusBadge({
  status,
  label,
}: {
  status: string | null | undefined;
  label?: string;
}) {
  const tone = toneOf(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${toneClasses(tone)}`}
    >
      {label ?? status ?? "desconocido"}
    </span>
  );
}
