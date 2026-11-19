import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@beacon/core/errors/app-error";

import { HttpMcpTransport } from "../src/http-transport.js";

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: {
    name: string;
    arguments: unknown;
    _meta: Record<string, unknown>;
  };
}

interface CapturedRequest {
  headers: IncomingMessage["headers"];
  body: RpcRequest;
}

type Responder = (request: RpcRequest) => {
  status?: number;
  contentType?: string;
  body: string;
};

let server: Server;
let baseUrl: string;
let respond: Responder;
const captured: CapturedRequest[] = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function envelope(request: RpcRequest, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
}

function toolText(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as RpcRequest;
      captured.push({ headers: req.headers, body });

      const response = respond(body);
      res.writeHead(response.status ?? 200, {
        "content-type": response.contentType ?? "application/json",
      });
      res.end(response.body);
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("HttpMcpTransport", () => {
  it("presenta bearers y headers modernos y desenvuelve el texto JSON", async () => {
    captured.length = 0;
    respond = (request) => ({ body: envelope(request, toolText('{"services":[]}')) });
    const transport = new HttpMcpTransport({ url: baseUrl, token: "service-token" });

    await expect(transport.callTool({ name: "list_services", args: {} })).resolves.toEqual({
      services: [],
    });

    const capturedRequest = captured[0];
    if (!capturedRequest) {
      throw new Error("el servidor de prueba no recibió ninguna petición");
    }
    const { headers, body } = capturedRequest;
    expect(headers.authorization).toBe("Bearer service-token");
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("list_services");
    expect(headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("list_services");
    expect(body.params._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    });
  });

  it("acepta una respuesta SSE y toma el mensaje con su id", async () => {
    respond = (request) => ({
      contentType: "text/event-stream",
      body: `event: message\ndata: ${envelope(request, toolText('{"ok":true}'))}\n\n`,
    });
    const transport = new HttpMcpTransport({ url: baseUrl, token: "service-token" });

    await expect(transport.callTool({ name: "list_services", args: {} })).resolves.toEqual({
      ok: true,
    });
  });

  it("convierte isError en upstream_error con el texto de la tool", async () => {
    respond = (request) => ({
      body: envelope(request, {
        isError: true,
        content: [{ type: "text", text: "invalid arguments" }],
      }),
    });
    const transport = new HttpMcpTransport({ url: baseUrl, token: "service-token" });

    await expect(transport.callTool({ name: "list_services", args: {} })).rejects.toMatchObject({
      code: "upstream_error",
      message: "invalid arguments",
    });
  });

  it("convierte un 401 en upstream_error sin filtrar el bearer", async () => {
    respond = () => ({
      status: 401,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32000, message: "unauthorized" },
      }),
    });
    const transport = new HttpMcpTransport({ url: baseUrl, token: "service-token" });

    const error = await transport
      .callTool({ name: "list_services", args: {} })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "upstream_error", statusCode: 502 });
    expect(JSON.stringify(error)).not.toContain("service-token");
  });

  it("corta por timeout", async () => {
    respond = () => ({ body: "" });
    const slow = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: toolText("{}") }));
      }, 500);
    });
    await new Promise<void>((resolve) => {
      slow.listen(0, "127.0.0.1", resolve);
    });
    const port = (slow.address() as AddressInfo).port;

    const transport = new HttpMcpTransport({
      url: `http://127.0.0.1:${port}/mcp`,
      token: "service-token",
      timeoutMs: 30,
    });

    try {
      await expect(
        transport.callTool({ name: "list_services", args: {} }),
      ).rejects.toMatchObject({ code: "timeout" });
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it("rechaza un timeout no positivo al construirse", () => {
    expect(
      () => new HttpMcpTransport({ url: baseUrl, token: "service-token", timeoutMs: 0 }),
    ).toThrow(/timeoutMs/);
  });
});