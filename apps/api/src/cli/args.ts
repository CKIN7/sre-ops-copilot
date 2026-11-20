import { parseArgs } from "node:util";

export interface CliArgs {
  command: string | undefined;
  runId: string | undefined;
  subcommand: string | undefined;
  goal: string | undefined;
  json: boolean;
  api: string | undefined;
  token: string | undefined;
  help: boolean;
}

/**
 * Tres comandos: `run`, `timeline` y `audit`. `parseArgs` en modo estricto para que
 * un typo falle en vez de ignorarse en silencio.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      goal: { type: "string", short: "g" },
      json: { type: "boolean", default: false },
      api: { type: "string" },
      token: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  return {
    command: positionals[0],
    runId: positionals[1],
    subcommand: positionals[2],
    goal: values.goal,
    json: values.json,
    api: values.api,
    token: values.token,
    help: values.help,
  };
}

export const USAGE = `Uso:
  beacon run --goal "<objetivo>" [--json] [--api URL] [--token TOKEN]
  beacon timeline <runId> [--json] [--api URL] [--token TOKEN]
  beacon audit verify [--json] [--api URL] [--token TOKEN]

Variables de entorno:
  BEACON_API_URL   URL de la API (por defecto http://127.0.0.1:3000)
  BEACON_TOKEN     token de operador; alternativa a --token
`;