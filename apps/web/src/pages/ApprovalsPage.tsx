import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "../api/client.js";
import { ProposalCard } from "../components/ProposalCard.js";

/**
 * Pantalla de aprobaciones (plan §11).
 *
 * Lista las propuestas del tenant y deja aprobar o rechazar cada una. Aprobar
 * **ejecuta** la escritura: la decisión y el apply son la misma llamada, y el
 * efecto es idempotente.
 *
 * El formulario de propuesta existe porque el flujo es demostrable de punta a
 * punta: abrir una propuesta, aprobarla y ver el estado del `apply`.
 */

type ToolName = "propose_rollback" | "propose_set_flag" | "propose_silence_alert";

const TOOLS: Array<{ name: ToolName; label: string; fields: Array<[string, string]> }> = [
  {
    name: "propose_rollback",
    label: "Rollback",
    fields: [
      ["service", "checkout"],
      ["to_version", "1.41.0"],
      ["reason", "pico de 5xx en checkout"],
    ],
  },
  {
    name: "propose_set_flag",
    label: "Cambio de flag",
    fields: [
      ["flag", "checkout.confirm.async"],
      ["value", "true"],
      ["reason", "el rollout nuevo falla"],
    ],
  },
  {
    name: "propose_silence_alert",
    label: "Silenciar alerta",
    fields: [
      ["alert_id", "1"],
      ["duration", "30m"],
      ["reason", "falsa alarma"],
    ],
  },
];

export function ApprovalsPage({ client }: { client: ApiClient }) {
  const queryClient = useQueryClient();
  const [tool, setTool] = useState<ToolName>("propose_rollback");
  const [fields, setFields] = useState<Record<string, string>>(
    Object.fromEntries(TOOLS[0]!.fields),
  );
  const [runId, setRunId] = useState("");
  const [proposalError, setProposalError] = useState<string | null>(null);

  const proposals = useQuery({
    queryKey: ["proposals"],
    queryFn: () => client.listProposals(),
  });

  const decide = useMutation({
    mutationFn: async (input: { id: string; decision: "approve" | "reject"; reason: string | null }) => {
      if (input.decision === "approve") {
        await client.approve(input.id, input.reason);
      } else {
        await client.reject(input.id, input.reason);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["proposals"] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      // La timeline del run también cambia: el `apply` es parte de su historia.
      await queryClient.invalidateQueries({ queryKey: ["run"] });
    },
  });

  const propose = useMutation({
    mutationFn: async () => {
      const args: Record<string, unknown> = { ...fields };
      if (tool === "propose_set_flag") {
        const raw = String(fields.value ?? "");
        args.value = raw === "true" ? true : raw === "false" ? false : raw;
      }
      return client.propose({
        tool,
        args,
        runId: runId.trim().length > 0 ? runId.trim() : null,
      });
    },
    onSuccess: async () => {
      setProposalError(null);
      await queryClient.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (error: Error) => {
      setProposalError(error.message);
    },
  });

  const current = TOOLS.find((entry) => entry.name === tool) ?? TOOLS[0]!;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Abrir una propuesta
        </h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <label className="text-xs text-slate-400">
            Tool
            <select
              value={tool}
              onChange={(event) => {
                const next = event.target.value as ToolName;
                setTool(next);
                setFields(
                  Object.fromEntries(
                    (TOOLS.find((entry) => entry.name === next) ?? TOOLS[0]!).fields,
                  ),
                );
              }}
              className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              {TOOLS.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          {current.fields.map(([name, placeholder]) => (
            <label key={name} className="text-xs text-slate-400">
              {name}
              <input
                value={fields[name] ?? ""}
                onChange={(event) =>
                  setFields((prev) => ({ ...prev, [name]: event.target.value }))
                }
                placeholder={placeholder}
                className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
              />
            </label>
          ))}

          <label className="text-xs text-slate-400">
            run_id (opcional)
            <input
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
              placeholder="ancla la propuesta a un run"
              className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            />
          </label>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => propose.mutate()}
            disabled={propose.isPending}
            className="rounded-md bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-white disabled:opacity-40"
          >
            {propose.isPending ? "proponiendo…" : "Proponer"}
          </button>
          {proposalError && <p className="text-xs text-rose-300">{proposalError}</p>}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Proponer no ejecuta nada: deja el plan pendiente de un humano, con su{" "}
          <code>approval_id</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Propuestas
        </h2>
        {proposals.isPending && <p className="text-xs text-slate-500">cargando…</p>}
        {proposals.isError && (
          <p className="text-xs text-rose-300">no se pudieron cargar las propuestas</p>
        )}
        {(proposals.data ?? []).map((proposal) => (
          <ProposalCard
            key={proposal.proposal.id}
            proposal={proposal}
            busy={decide.isPending}
            onApprove={async (id, reason) => {
              await decide.mutateAsync({ id, decision: "approve", reason });
            }}
            onReject={async (id, reason) => {
              await decide.mutateAsync({ id, decision: "reject", reason });
            }}
          />
        ))}
        {proposals.data?.length === 0 && (
          <p className="text-xs text-slate-500">no hay propuestas todavía</p>
        )}
      </section>
    </div>
  );
}
