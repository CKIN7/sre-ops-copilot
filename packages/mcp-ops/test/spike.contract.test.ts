import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Los tests leen el .env de la raiz si existe; sin DATABASE_URL se saltan.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No hay .env en la raiz: el test se saltara si DATABASE_URL no esta en el entorno.
}

const databaseUrl = process.env.DATABASE_URL;
const serverEntry = fileURLToPath(new URL("../dist/server.js", import.meta.url));

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  if (!block?.text) {
    throw new Error("tool result has no text content");
  }
  return block.text;
}

describe.skipIf(!databaseUrl)("contrato stdio de mcp-ops", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
    client = new Client(
      { name: "beacon-contract-test", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client.close();
  });

  it("descubre las tools del spike", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "list_services",
      "query_metrics",
    ]);
  });

  it("list_services devuelve los 6 servicios sembrados", async () => {
    const result = await client.callTool({ name: "list_services", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as { services: unknown[] };
    expect(payload.services).toHaveLength(6);
  });

  it("query_metrics devuelve puntos dentro del limite de 300", async () => {
    const result = await client.callTool({
      name: "query_metrics",
      arguments: {
        service: "checkout",
        metric: "http_5xx_rate",
        window: "2h",
        step: "1m",
        agg: "avg",
      },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as {
      points: Array<{ timestamp: string; value: number }>;
    };
    expect(payload.points.length).toBeGreaterThan(0);
    expect(payload.points.length).toBeLessThanOrEqual(300);
    expect(typeof payload.points[0]?.value).toBe("number");
  });
});
