import { ApiClient } from "./client.js";
import { parseCliArgs, USAGE, type CliArgs } from "./args.js";
import { formatRunResult, formatTimeline } from "./format.js";

const DEFAULT_API_URL = "http://127.0.0.1:3000";

export interface CliIo {
  write: (text: string) => void;
  writeError: (text: string) => void;
}

export interface RunCliOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  io: CliIo;
}

function resolveApi(args: CliArgs, env: NodeJS.ProcessEnv): string {
  return args.api ?? env.BEACON_API_URL ?? DEFAULT_API_URL;
}

async function runCommand(
  args: CliArgs,
  client: ApiClient,
  options: RunCliOptions,
): Promise<number> {
  if (!args.goal) {
    options.io.writeError(`falta --goal\n\n${USAGE}`);
    return 2;
  }

  const result = await client.startRun(args.goal);
  const timeline = await client.getTimeline(result.runId);

  if (args.json) {
    options.io.write(`${JSON.stringify({ run: result, timeline }, null, 2)}\n`);
  } else {
    options.io.write(formatRunResult(result));
    options.io.write(formatTimeline(timeline));
  }

  if (result.status !== "succeeded") {
    options.io.writeError(`run ${result.runId} terminó en ${result.status}\n`);
    return 1;
  }
  return 0;
}

async function timelineCommand(
  args: CliArgs,
  client: ApiClient,
  options: RunCliOptions,
): Promise<number> {
  if (!args.runId) {
    options.io.writeError(`falta el id del run\n\n${USAGE}`);
    return 2;
  }

  const timeline = await client.getTimeline(args.runId);
  options.io.write(
    args.json
      ? `${JSON.stringify(timeline, null, 2)}\n`
      : formatTimeline(timeline),
  );
  return 0;
}

/**
 * Punto de entrada testeable: recibe argv, entorno, fetch e IO. `cli.ts` solo
 * conecta esto con el proceso; ningún test necesita spawnear un servidor.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(options.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "argumentos inválidos";
    options.io.writeError(`${message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    options.io.write(USAGE);
    return 0;
  }
  if (!args.command) {
    options.io.writeError(USAGE);
    return 2;
  }

  const token = args.token ?? options.env.BEACON_TOKEN;
  if (!token) {
    options.io.writeError("falta BEACON_TOKEN o --token\n");
    return 1;
  }

  const client = new ApiClient(resolveApi(args, options.env), token, options.fetch);

  try {
    switch (args.command) {
      case "run":
        return await runCommand(args, client, options);
      case "timeline":
        return await timelineCommand(args, client, options);
      default:
        options.io.writeError(`comando desconocido: ${args.command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "error desconocido";
    options.io.writeError(`${message}\n`);
    return 1;
  }
}