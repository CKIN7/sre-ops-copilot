import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import { ApiClient, ApiError } from "./api/client.js";
import { clearToken, readToken, writeToken } from "./api/token.js";
import { TokenGate } from "./components/TokenGate.js";
import { AboutPage } from "./pages/AboutPage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { RunsPage } from "./pages/RunsPage.js";

type Tab = "runs" | "approvals" | "about";

/**
 * Shell de la UI de Beacon (plan §11).
 *
 * Tres pestañas: runs (la timeline), aprobaciones (la cola de decisiones) y about
 * (la tabla de honestidad del §11.7 y el estado de la demo).
 */
export function App() {
  const [token, setToken] = useState(() => readToken());
  const [tab, setTab] = useState<Tab>("runs");
  // El cliente se rehace cuando cambia el token: el bearer viaja siempre en la
  // cabecera de cada petición.
  const client = useMemo(() => new ApiClient({ token }), [token]);
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <Shell client={client} token={token} setToken={setToken} tab={tab} setTab={setTab} />
    </QueryClientProvider>
  );
}

function Shell({
  client,
  token,
  setToken,
  tab,
  setTab,
}: {
  client: ApiClient;
  token: string;
  setToken: (value: string) => void;
  tab: Tab;
  setTab: (value: Tab) => void;
}) {
  /**
   * Sondaje de la API: si responde 401 y no hay token, la UI pide uno. En local el
   * proxy ya inyecta el bearer del `.env`, así que ni se ve la puerta.
   */
  const probe = useQuery({
    queryKey: ["probe", token],
    queryFn: () => client.listRuns(),
    retry: false,
    staleTime: 30_000,
  });

  const demo = useQuery({
    queryKey: ["demo-status"],
    queryFn: () => client.getDemoStatus(),
    retry: false,
    staleTime: 15_000,
  });

  const unauthorized = probe.error instanceof ApiError && probe.error.status === 401;

  if (token.length === 0 && unauthorized) {
    return (
      <TokenGate
        onSubmit={(value) => {
          writeToken(value);
          setToken(value);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/40">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <div>
            <h1 className="text-sm font-semibold text-slate-100">Beacon</h1>
            <p className="text-xs text-slate-500">copiloto de guardia</p>
          </div>
          <nav className="flex gap-1">
            {(
              [
                ["runs", "Runs"],
                ["approvals", "Aprobaciones"],
                ["about", "Honestidad"],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                  tab === key
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-400 hover:bg-slate-800/60"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => {
              clearToken();
              setToken("");
            }}
            className="ml-auto text-xs text-slate-500 hover:text-slate-300"
          >
            cerrar sesión
          </button>
        </div>
      </header>

      {demo.data?.replayOnly && (
        <div className="border-b border-amber-900/60 bg-amber-950/40 px-4 py-2 text-center text-xs text-amber-200">
          Modo grabado (REPLAY_ONLY): la demo sirve runs desde fixtures y no ejecuta
          escrituras. Es el circuit breaker, no un fallo.
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "runs" && <RunsPage client={client} demo={demo.data} />}
        {tab === "approvals" && <ApprovalsPage client={client} />}
        {tab === "about" && <AboutPage demo={demo.data} />}
      </main>
    </div>
  );
}
