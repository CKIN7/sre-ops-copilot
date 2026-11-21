import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiClient } from "./api/client.js";
import { clearToken, readToken, writeToken } from "./api/token.js";
import { TokenGate } from "./components/TokenGate.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { RunsPage } from "./pages/RunsPage.js";

type Tab = "runs" | "approvals";

/**
 * Shell de la UI de Beacon (plan §11).
 *
 * Tres pestañas: runs (la timeline), aprobaciones (la cola de decisiones) y `about`
 * (la tabla de honestidad: qué es real y qué es simulado).
 */
export function App() {
  const [token, setToken] = useState(() => readToken());
  const [tab, setTab] = useState<Tab>("runs");
  // El cliente se rehace cuando cambia el token: el bearer viaja siempre en la
  // cabecera de cada petición.
  const client = useMemo(() => new ApiClient({ token }), [token]);
  const [queryClient] = useState(() => new QueryClient());

  if (token.length === 0) {
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
    <QueryClientProvider client={queryClient}>
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

        <main className="mx-auto max-w-6xl px-4 py-6">
          {tab === "runs" ? <RunsPage client={client} /> : <ApprovalsPage client={client} />}
        </main>
      </div>
    </QueryClientProvider>
  );
}
