import type { ProposalDetail } from "@beacon/core/domain/proposals";
import type { Run, RunTimeline } from "@beacon/core/domain/runs";

/**
 * Cliente de la API de Beacon (plan §11).
 *
 * Solo `fetch` y los DTOs de `core`: la UI no habla con Postgres ni con `mcp-ops`.
 * El bearer viaja en la cabecera y nunca en la URL.
 *
 * El servidor de Vite hace de proxy (`/api`), así que el mismo origen sirve la UI y
 * la API: no hay CORS ni tokens en la query string.
 */
export interface ApiClientOptions {
  baseUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ProposalSummary {
  proposal: ProposalDetail["proposal"];
  approval: ProposalDetail["approval"];
  effect: ProposalDetail["effect"];
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = (options.baseUrl ?? "/api").replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async listRuns(): Promise<Run[]> {
    const payload = await this.#request<{ runs: Run[] }>("/runs");
    return payload.runs;
  }

  async getTimeline(runId: string): Promise<RunTimeline> {
    return this.#request<RunTimeline>(`/runs/${runId}`);
  }

  async listProposals(status?: string): Promise<ProposalSummary[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const payload = await this.#request<{ proposals: ProposalSummary[] }>(
      `/proposals${query}`,
    );
    return payload.proposals;
  }

  async getProposal(id: string): Promise<ProposalSummary> {
    const payload = await this.#request<{ proposal: ProposalSummary }>(`/proposals/${id}`);
    return payload.proposal;
  }

  async propose(input: {
    tool: string;
    args: Record<string, unknown>;
    runId?: string | null;
  }): Promise<ProposalSummary> {
    const payload = await this.#request<{ proposal: ProposalSummary }>("/proposals", {
      method: "POST",
      body: {
        tool: input.tool,
        args: input.args,
        run_id: input.runId ?? null,
      },
    });
    return payload.proposal;
  }

  async approve(id: string, reason: string | null): Promise<ProposalSummary> {
    const payload = await this.#request<{ proposal: ProposalSummary }>(
      `/proposals/${id}/approve`,
      { method: "POST", body: { reason } },
    );
    return payload.proposal;
  }

  async reject(id: string, reason: string | null): Promise<ProposalSummary> {
    const payload = await this.#request<{ proposal: ProposalSummary }>(
      `/proposals/${id}/reject`,
      { method: "POST", body: { reason } },
    );
    return payload.proposal;
  }

  async #request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    const raw = await response.text();
    if (!response.ok) {
      let code = "http_error";
      let message = raw;
      try {
        const payload = JSON.parse(raw) as { error?: { code?: string; message?: string } };
        code = payload.error?.code ?? code;
        message = payload.error?.message ?? message;
      } catch {
        // La respuesta no era JSON: se devuelve tal cual.
      }
      throw new ApiError(response.status, code, message);
    }

    return JSON.parse(raw) as T;
  }
}
