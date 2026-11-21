import type { RunTimeline } from "@beacon/core/domain/runs";

import { StatusBadge } from "./StatusBadge.js";

/**
 * Timeline de un run (plan §11).
 *
 * Cada step es un turno del modelo o una tool call; cada tool call muestra sus args
 * **redactados** (los que se guardaron) y su estado. Las propuestas del run cuelgan
 * de la tool call que las propuso y muestran el estado del `apply`: `applied`,
 * `degraded` si no se pudo verificar, `conflict` o `timeout`.
 */
export function TimelineView({ timeline }: { timeline: RunTimeline }) {
  const { run, steps, proposals } = timeline;
  const proposalsByCall = new Map<string, (typeof proposals)[number]>();
  for (const detail of proposals) {
    if (detail.proposal.toolCallId) {
      proposalsByCall.set(detail.proposal.toolCallId, detail);
    }
  }

  return (
    <div className="space-y-4">
      <header className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-100">{run.goal}</h2>
          <StatusBadge status={run.status} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-4">
          <div>
            <dt className="text-slate-500">run</dt>
            <dd className="font-mono text-slate-300">{run.id.slice(0, 8)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">origen</dt>
            <dd className="text-slate-300">{run.trigger}</dd>
          </div>
          <div>
            <dt className="text-slate-500">coste</dt>
            <dd className="text-slate-300">{(run.costCents / 100).toFixed(4)} €</dd>
          </div>
          <div>
            <dt className="text-slate-500">tokens</dt>
            <dd className="text-slate-300">{run.tokensIn + run.tokensOut}</dd>
          </div>
        </dl>
      </header>

      <ol className="space-y-2">
        {steps.map((step) => (
          <li
            key={step.id}
            className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
          >
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-mono text-slate-500">#{step.idx}</span>
              <StatusBadge status={step.kind === "model" ? "ok" : "info"} label={step.kind} />
              {step.model && <span className="text-slate-400">{step.model}</span>}
              {step.promptVersion && (
                <span className="text-slate-500">{step.promptVersion}</span>
              )}
              <span className="ml-auto text-slate-500">{step.latencyMs} ms</span>
            </div>

            {step.toolCalls.map((call) => {
              const detail = proposalsByCall.get(call.id);
              return (
                <div key={call.id} className="mt-2 border-l-2 border-slate-800 pl-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-slate-200">{call.tool}</span>
                    <StatusBadge status={call.status} />
                    {call.errorCode && (
                      <span className="text-rose-300">{call.errorCode}</span>
                    )}
                    {call.finishedAt && (
                      <span className="ml-auto text-slate-500">
                        {new Date(call.finishedAt).toLocaleTimeString("es-ES")}
                      </span>
                    )}
                  </div>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-950/70 p-2 text-[11px] text-slate-400">
                    {JSON.stringify(call.argsRedacted, null, 2)}
                  </pre>

                  {detail && (
                    <div className="mt-2 rounded-md bg-slate-950/60 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-slate-400">apply:</span>
                        <StatusBadge status={detail.proposal.status} />
                        {detail.effect && (
                          <>
                            <StatusBadge
                              status={detail.effect.verified ? "ok" : "degraded"}
                              label={detail.effect.verified ? "verificado" : "sin verificar"}
                            />
                            <span className="text-slate-500">{detail.effect.durationMs} ms</span>
                          </>
                        )}
                      </div>
                      {detail.effect?.errorCode && (
                        <p className="mt-1 text-rose-300">{detail.effect.errorCode}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </li>
        ))}
      </ol>
    </div>
  );
}
