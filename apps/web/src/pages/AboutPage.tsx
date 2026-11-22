import type { DemoStatus } from "../api/client.js";

/**
 * Vista `/about`: la tabla de honestidad del plan §11.7 y el estado de la demo.
 *
 * Decir lo que no es real es parte del producto: el visitante tiene que saber que
 * las metricas son sinteticas, que el efecto del rollback publico vive en Postgres
 * y que k6 y el contrato sandbox pueden estar pendientes.
 */
export function AboutPage({ demo }: { demo: DemoStatus | undefined }) {
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-100">Que es real y que no</h2>
        <p className="mt-1 text-xs text-slate-500">
          Beacon no inventa cifras: si algo esta simulado, se dice aqui.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-2 pr-4 font-semibold">Componente</th>
                <th className="py-2 pr-4 font-semibold">Real</th>
                <th className="py-2 font-semibold">Simulado</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {[
                ["Metricas, logs y deploys", "", "dataset sintetico"],
                ["Authn, tenants, presupuesto y policies", "si", ""],
                ["Gateway, auditoria y aprobaciones", "si", ""],
                ["propose_* / apply / idempotencia", "si", ""],
                ["Efecto del rollback en la demo publica", "", "estado en Postgres"],
                ["Efecto del rollback en modo sandbox", "kubectl real", ""],
                ["Modelo", "", "mock guionizado, sin LLM ni coste"],
                ["Contrato sandbox 6/6", "pendiente de ejecucion", ""],
                ["p95 de k6", "pendiente de ejecucion", ""],
              ].map(([component, real, simulated]) => (
                <tr key={component} className="border-b border-slate-800/60">
                  <td className="py-2 pr-4">{component}</td>
                  <td className="py-2 pr-4 text-emerald-300">{real || "—"}</td>
                  <td className="py-2 text-amber-300">{simulated || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-100">Demo publica</h2>
        {!demo?.enabled && (
          <p className="mt-2 text-xs text-slate-400">
            Esta instancia no corre en <code>DEMO_MODE</code>: las escrituras siguen
            en dos fases y requieren aprobacion humana.
          </p>
        )}
        {demo?.enabled && (
          <div className="mt-2 space-y-1 text-xs text-slate-400">
            <p>
              Modo grabado: <strong>{demo.replayOnly ? "si (REPLAY_ONLY)" : "no"}</strong>
            </p>
            <p>
              Sesiones hoy: {demo.sessionsToday ?? "—"} / {demo.dailyLimit ?? "—"}
            </p>
            <p>Fallos de dependencia: {demo.failures ?? "—"}</p>
            <p className="text-slate-500">
              La demo nunca escribe de verdad: el efecto es estado en Postgres y el
              gateway cae a replay si se supera el techo.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-100">Limitaciones conocidas</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-400">
          <li>El modelo es guionizado y determinista: coste de proveedor 0 centimos.</li>
          <li>
            El <code>SandboxExecutor</code> solo cubre rollback; <code>set_flag</code> y
            <code>silence_alert</code> siguen simulados y la evidencia lo dice.
          </li>
          <li>La suite de contrato 6/6 y el p95 de k6 no se publican sin medicion real.</li>
          <li>No hay reanudacion del run tras aprobar: el apply va en la misma llamada.</li>
        </ul>
      </section>
    </div>
  );
}
