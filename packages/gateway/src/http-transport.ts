import { AppError } from "@beacon/core/errors/app-error";
import type { ReadToolName } from "@beacon/core/schemas/tools";

import type { McpToolRequest, McpTransport } from "./transport.js";

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

export interface HttpMcpTransportOptions {
  /** URL del endpoint `POST /mcp` de mcp-ops. */
  url: string;
  /** Bearer de servicio; nunca es una credencial de usuario. */
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonRpcError(payload: unknown): JsonRpcError | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return undefined;
  }
  const { code, message, data } = payload.error;
  if (typeof code !== "number" || typeof message !== "string") {
    return undefined;
  }
  return { code, message, data };
}

function firstText(result: Record<string, unknown>): string | undefined {
  if (!Array.isArray(result.content)) {
    return undefined;
  }
  for (const block of result.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

/** Desenvuelve el `CallToolResult` de MCP: texto JSON dentro de `content`. */
function extractToolResult(payload: unknown): unknown {
  if (!isRecord(payload) || !("result" in payload)) {
    throw new AppError("upstream_error", "mcp-ops returned no result");
  }

  const result = payload.result;
  if (!isRecord(result)) {
    throw new AppError("upstream_error", "mcp-ops returned a non-object result");
  }

  const text = firstText(result);
  if (result.isError === true) {
    throw new AppError("upstream_error", text ?? "tool call failed", {
      statusCode: 502,
    });
  }
  if (text === undefined) {
    throw new AppError("upstream_error", "tool result has no text content");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Una tool futura puede devolver texto plano; no lo convertimos en error.
    return text;
  }
}

function parseSseEnvelope(text: string, id: number): unknown {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (data === "") {
      continue;
    }
    try {
      const message: unknown = JSON.parse(data);
      if (isRecord(message) && message.id === id) {
        return message;
      }
    } catch {
      // Comentarios y keep-alives de SSE no son JSON: se ignoran.
    }
  }
  return undefined;
}

/**
 * Cliente JSON-RPC de `mcp-ops` sobre Streamable HTTP stateless (ADR-002).
 *
 * Presenta el bearer de servicio y la revisión fijada; no abre sesión ni guarda
 * estado entre llamadas. Un fallo de red, timeout o `isError` se traduce a
 * `AppError` para que el orquestador lo registre como tool call fallida.
 */
export class HttpMcpTransport implements McpTransport {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #nextId = 1;

  constructor(options: HttpMcpTransportOptions) {
    if (!Number.isFinite(options.timeoutMs ?? 1) || (options.timeoutMs ?? 1) <= 0) {
      throw new AppError("internal", "timeoutMs must be a positive number");
    }

    this.#url = options.url;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async callTool({ name, args }: McpToolRequest): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;

    const body = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    };

    const response = await this.#send(body, name);
    const text = await response.text();
    const payload = this.#parse(response.headers.get("content-type"), text, id);
    const rpcError = readJsonRpcError(payload);

    if (!response.ok) {
      throw new AppError(
        "upstream_error",
        rpcError
          ? `mcp-ops ${response.status}: ${rpcError.message}`
          : `mcp-ops responded ${response.status}`,
        { statusCode: 502, details: rpcError ?? { status: response.status } },
      );
    }

    if (rpcError) {
      throw new AppError("upstream_error", `mcp-ops error ${rpcError.code}: ${rpcError.message}`, {
        statusCode: 502,
        details: rpcError,
      });
    }

    return extractToolResult(payload);
  }

  async #send(body: unknown, tool: ReadToolName): Promise<Response> {
    try {
      return await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.#token}`,
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-method": "tools/call",
          "mcp-name": tool,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown transport error";
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new AppError("timeout", `mcp-ops timed out after ${this.#timeoutMs}ms`, {
          details: { tool },
        });
      }
      throw new AppError("upstream_error", `no se pudo alcanzar mcp-ops: ${message}`, {
        details: { tool },
      });
    }
  }

  #parse(contentType: string | null, text: string, id: number): unknown {
    if (contentType?.includes("text/event-stream")) {
      const envelope = parseSseEnvelope(text, id);
      if (envelope === undefined) {
        throw new AppError("upstream_error", "mcp-ops returned no matching SSE envelope");
      }
      return envelope;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError("upstream_error", "mcp-ops returned a non-JSON response");
    }
  }
}