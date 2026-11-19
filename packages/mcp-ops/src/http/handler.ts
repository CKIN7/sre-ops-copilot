import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { Pool } from "pg";

import { SERVER_NAME, SERVER_VERSION } from "../meta.js";
import { registerTools } from "../tools/register.js";
import { isAuthorized } from "./auth.js";

export interface OpsHttpOptions {
  pool: Pool;
  /** Token de servicio: el gateway lo presenta en `Authorization: Bearer`. */
  authToken: string;
  /** Destino de errores fuera de banda; nunca altera la respuesta. */
  onError?: (error: Error) => void;
}

export interface OpsHttpHandler {
  fetch: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
}

const BEARER_CHALLENGE = 'Bearer realm="beacon-mcp-ops"';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Borde HTTP de `mcp-ops`: Streamable HTTP stateless en `POST /mcp` (ADR-002).
 *
 * La autenticación vive aquí, no en el SDK: `createMcpHandler` no verifica
 * tokens. Sin sesiones de protocolo ni `Mcp-Session-Id`: cada POST es una unidad
 * de servicio y el estado del run vive en Postgres.
 */
export function createOpsHttpHandler(options: OpsHttpOptions): OpsHttpHandler {
  const mcp = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
      );
      registerTools(server, options.pool);
      return server;
    },
    {
      // Coherente con stdio: la revisión 2025 está fuera. Un cliente antiguo
      // recibe el error de versión no soportada en vez de servirse en silencio.
      legacy: "reject",
      onerror: (error) => options.onError?.(error),
    },
  );

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method not allowed.", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        return json(200, { status: "ok", service: SERVER_NAME, version: SERVER_VERSION });
      }

      if (url.pathname !== "/mcp") {
        return json(404, { error: "not_found" });
      }

      if (request.method !== "POST") {
        // 2025 usaba GET para abrir el stream de sesión; aquí no hay sesión.
        return new Response("Method not allowed.", {
          status: 405,
          headers: { allow: "POST" },
        });
      }

      if (!isAuthorized(request.headers.get("authorization"), options.authToken)) {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": BEARER_CHALLENGE },
        });
      }

      return mcp.fetch(request);
    },
    close: () => mcp.close(),
  };
}
