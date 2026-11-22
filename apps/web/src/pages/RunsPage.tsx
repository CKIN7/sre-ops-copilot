import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ApiClient, DemoStatus } from "../api/client.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TimelineView } from "../components/TimelineView.js";

/**
 * Pantalla de runs: la lista de lo que pasó y, al elegir uno, su timeline.
 *
 * La timeline incluye las propuestas del run con el estado de su `apply`, que es
 * donde se ve si una escritura se aplicó de verdad o quedó a medias.
 */
const SCENARIOS: Array<{ label: string; goal: string }> = [
  {
    label: "Deploy malo en checkout",
    goal: "Investiga el pico de errores 5xx en checkout tras el ultimo deploy",
  },
  {
    label: "Falsa alarma",
    goal: "Revisa la alerta de latencia en web y decide si hay que actuar",
  },
  {
    label: "Inyeccion en los logs",
    goal: "Investiga un log sospechoso en checkout que pide ignorar las reglas",
  },
];

export function RunsPage({ client, demo }: { client: ApiClient; demo?: DemoStatus }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => client.listRuns(),
  });

  const start = useMutation({
    mutationFn: (goal: string) => client.startRun(goal),
    onSuccess: async () => {
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const runId = selectedId ?? runs.data?.[0]?.id ?? null;
  const timeline = useQuery({
    queryKey: ["run", runId],
    queryFn: () => client.getTimeline(runId as string),
    enabled: runId !== null,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
        <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Escenarios guiados
          </h3>
          <div className="mt-2 flex flex-col gap-1">
            {SCENARIOS.map((scenario) => (
              <button
                key={scenario.label}
                type="button"
                disabled={start.isPending || demo?.replayOnly === true}
                onClick={() => start.mutate(scenario.goal)}
                className="rounded-md border border-slate-800 px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {scenario.label}
              </button>
            ))}
          </div>
          {demo?.replayOnly && (
            <p className="mt-2 text-[11px] text-amber-300">
              REPLAY_ONLY: los escenarios se sirven desde fixtures.
            </p>
          )}
          {start.isError && (
            <p className="mt-2 text-[11px] text-rose-300">
              no se pudo lanzar: {String(start.error?.message ?? start.error)}
            </p>
          )}
        </div>

        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Runs recientes
        </h2>
        {runs.isPending && <p className="mt-3 text-xs text-slate-500">cargando…</p>}
        {runs.isError && (
          <p className="mt-3 text-xs text-rose-300">
            no se pudieron cargar los runs: {String(runs.error?.message ?? runs.error)}
          </p>
        )}
        <ul className="mt-2 space-y-1">
          {(runs.data ?? []).map((run) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => setSelectedId(run.id)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-800 ${
                  runId === run.id ? "bg-slate-800" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <StatusBadge status={run.status} />
                  <span className="ml-auto font-mono text-slate-600">{run.id.slice(0, 8)}</span>
                </div>
                <p className="mt-1 truncate text-slate-300">{run.goal}</p>
              </button>
            </li>
          ))}
        </ul>
        {runs.data?.length === 0 && (
          <p className="mt-3 text-xs text-slate-500">
            no hay runs todavía. Lanza uno con el CLI o desde la API.
          </p>
        )}
      </section>

      <section>
        {runId === null && (
          <p className="text-xs text-slate-500">elige un run para ver su timeline</p>
        )}
        {runId !== null && timeline.isPending && (
          <p className="text-xs text-slate-500">cargando timeline…</p>
        )}
        {timeline.isError && (
          <p className="text-xs text-rose-300">no se pudo cargar la timeline</p>
        )}
        {timeline.data && <TimelineView timeline={timeline.data} />}
      </section>
    </div>
  );
}
