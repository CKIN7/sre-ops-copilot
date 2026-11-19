import type { RunTimeline } from "@beacon/core/domain/runs";
import type { RunResult } from "@beacon/orchestrator/orchestrator";

const REQUEST_TIMEOUT_MS = 120_000;

export class ApiClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiClientError";
  }
}

interface RequestInitBody {
  method: "GET" | "POST";
  body?: unknown;
}

function errorMessage(status: number, raw: string): string {
  try {
    const payload = JSON.parse(raw) as {
      error?: { code?: string; message?: string };
    };
    const code = payload.error?.code ?? "http_error";
    const message = payload.error?.message ?? raw;
    return `${status} ${code}: ${message}`;
  } catch {
    return `${status}: ${raw === "" ? "respuesta vacía" : raw}`;
  }
}

/**
 * Cliente del CLI, sin dependencias: usa `fetch` y los DTOs de la API. No conoce
 * Postgres ni el gateway; el CLI nunca habla directo con `mcp-ops`.
 */
export class ApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async startRun(goal: string): Promise<RunResult> {
    const payload = await this.#request("/runs", {
      method: "POST",
      body: { goal, trigger: "cli" },
    });

    const run = (payload as { run?: RunResult }).run;
    if (!run) {
      throw new ApiClientError("la API no devolvió el run");
    }
    return run;
  }

  async getTimeline(runId: string): Promise<RunTimeline> {
    return (await this.#request(
      `/runs/${encodeURIComponent(runId)}`,
      { method: "GET" },
    )) as RunTimeline;
  }

  async #request(path: string, init: RequestInitBody): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "error de red";
      throw new ApiClientError(`no se pudo alcanzar la API: ${message}`);
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new ApiClientError(errorMessage(response.status, raw));
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ApiClientError("la API devolvió una respuesta que no es JSON");
    }
  }
}