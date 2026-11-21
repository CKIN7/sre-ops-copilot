import { useState } from "react";

/**
 * Puerta de entrada: la UI necesita un bearer para hablar con la API.
 *
 * Es el token de servicio local (el mismo que va en `BEACON_TOKEN`). Se guarda en el
 * navegador y viaja en la cabecera, nunca en la URL.
 */
export function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [token, setToken] = useState("");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900/60 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          const value = token.trim();
          if (value.length > 0) {
            onSubmit(value);
          }
        }}
      >
        <h1 className="text-lg font-semibold text-slate-100">Beacon</h1>
        <p className="mt-1 text-sm text-slate-400">
          Copiloto de guardia: investiga, propone y no ejecuta nada sin que un humano lo
          apruebe.
        </p>

        <label className="mt-5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Bearer de la API
        </label>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="BEACON_TOKEN"
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
        />

        <button
          type="submit"
          disabled={token.trim().length === 0}
          className="mt-4 w-full rounded-md bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-white disabled:opacity-40"
        >
          Entrar
        </button>

        <p className="mt-4 text-xs text-slate-500">
          En local es el valor de <code>BEACON_TOKEN</code> del <code>.env</code>. La
          identidad del usuario sale del token: la UI nunca lo elige.
        </p>
      </form>
    </main>
  );
}
