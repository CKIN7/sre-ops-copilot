import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "../src/db/pool.js";
import { createOpsHttpHandler } from "../src/http/handler.js";
import { createNodeServer } from "../src/http/node.js";

// Igual que el contrato stdio: si hay .env se usa; si no, las tools que tocan
// Postgres se saltan y el resto del transporte se prueba igual.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // Sin .env: DATABASE_URL puede venir del entorno (CI).
}

const databaseUrl = process.env.DATABASE_URL;
const TOKEN = "contract-token-0123456789abcdef0123456789abcdef";
const PROTOCOL_VERSION = "2026-07-28";

const pool = createPool(databaseUrl ?? "postgres://beacon:beacon@127.0.0.1:1/beacon");
const handler = createOpsHttpHandler({
  pool,
  authToken: TOKEN,
  onError: () => {
    // El contrato no imprime ruido: los errores de protocolo se afirman abajo.
  },
});
const server = createNodeServer(handler);

let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await handler.close();
  await pool.end();
});

interface Envelope {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function modernRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Envelope {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

interface PostOptions {
  token?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
}

function postMcp(options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  }

  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

function headersFor(envelope: Envelope): Record<string, string> {
  const name = envelope.method === "tools/call" ? String(envelope.params.name) : undefined;
  return {
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": envelope.method,
    ...(name ? { "mcp-name": name } : {}),
  };
}

describe("borde HTTP de mcp-ops", () => {
  it("expone /health sin autenticación", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("rechaza /mcp sin bearer", async () => {
    const response = await postMcp({ token: null });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rechaza /mcp con un bearer distinto", async () => {
    const response = await postMcp({ token: `${TOKEN}-otro` });
    expect(response.status).toBe(401);
  });

  it("no sirve GET /mcp: no hay sesiones que reanudar", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("devuelve 404 en rutas desconocidas", async () => {
    const response = await fetch(`${baseUrl}/otra`);
    expect(response.status).toBe(404);
  });

  it("lista las 10 tools con la revisión 2026-07-28", async () => {
    const envelope = modernRequest(1, "tools/list");
    const response = await postMcp({ headers: headersFor(envelope), body: envelope });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(payload.result.tools.map((tool) => tool.name).sort()).toEqual([
      "get_deploys",
      "get_feature_flags",
      "get_oncall",
      "get_service",
      "get_trace_summary",
      "list_alerts",
      "list_services",
      "query_metrics",
      "search_logs",
      "search_runbooks",
    ]);
  });

  it("rechaza header/body incoherentes con -32020", async () => {
    const envelope = modernRequest(2, "tools/list");
    const response = await postMcp({
      headers: { ...headersFor(envelope), "mcp-method": "tools/call" },
      body: envelope,
    });
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error: { code: number } };
    expect(payload.error.code).toBe(-32020);
  });

  it("rechaza tráfico 2025 sin envelope moderno", async () => {
    const response = await postMcp({
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    });
    expect(response.status).toBe(400);
  });
});

describe.skipIf(!databaseUrl)("tools por HTTP contra el dataset sembrado", () => {
  it("list_services devuelve los 6 servicios", async () => {
    const envelope = modernRequest(10, "tools/call", {
      name: "list_services",
      arguments: {},
    });
    const response = await postMcp({ headers: headersFor(envelope), body: envelope });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      result: { content: Array<{ type: string; text?: string }>; isError?: boolean };
    };
    expect(payload.result.isError).toBeFalsy();

    const text = payload.result.content.find((item) => item.type === "text")?.text;
    const parsed = JSON.parse(text ?? "{}") as { services: Array<{ slug: string }> };
    expect(parsed.services.map((service) => service.slug)).toEqual([
      "api",
      "checkout",
      "edge",
      "inventory",
      "payments",
      "web",
    ]);
  });
});
