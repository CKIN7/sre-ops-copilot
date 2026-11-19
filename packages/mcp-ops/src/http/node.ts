import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

import type { OpsHttpHandler } from "./handler.js";

export type FetchHandler = (request: Request) => Promise<Response>;

function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    // Necesario para enviar un cuerpo en streaming con fetch de undici.
    duplex: "half",
  } as RequestInit);
}

async function writeResponse(
  method: string,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });

  res.writeHead(response.status, headers);

  if (method === "HEAD" || !response.body) {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("error", reject);
    body.on("end", resolve);
    body.pipe(res);
  });
}

/**
 * Adaptador mínimo de `node:http` al handler fetch-shaped del SDK. Evita una
 * dependencia extra (Express, Fastify) en un paquete que solo sirve MCP.
 */
export function createNodeServer(handler: FetchHandler | OpsHttpHandler): Server {
  const fetchHandler = typeof handler === "function" ? handler : handler.fetch;

  return createServer((req, res) => {
    const method = req.method ?? "GET";

    void (async () => {
      try {
        const response = await fetchHandler(toRequest(req));
        await writeResponse(method, res, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        process.stderr.write(`[beacon-mcp-ops] error sirviendo HTTP: ${message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "internal_error" }));
        } else {
          res.destroy();
        }
      }
    })();
  });
}
