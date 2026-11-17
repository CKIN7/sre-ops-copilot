import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const PROTOCOL_REVISION = "2026-07-28";
const SERVER_ENTRY = fileURLToPath(new URL("../server.js", import.meta.url));

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  if (!block?.text) {
    throw new Error("tool result has no text content");
  }
  return block.text;
}

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function main(): Promise<void> {
  const startedAt = performance.now();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: inheritedEnv(),
    stderr: "inherit",
  });

  const client = new Client(
    { name: "beacon-spike-client", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: PROTOCOL_REVISION } } },
  );

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    console.log(`[spike] revision fijada: ${PROTOCOL_REVISION}`);
    console.log(`[spike] tools descubiertas (${names.length}): ${names.join(", ")}`);

    const services = await client.callTool({ name: "list_services", arguments: {} });
    const servicesPayload = JSON.parse(textOf(services)) as {
      services: Array<{ slug: string }>;
    };
    console.log(
      `[spike] list_services devolvio ${servicesPayload.services.length} servicios: ${servicesPayload.services
        .map((service) => service.slug)
        .join(", ")}`,
    );

    const metrics = await client.callTool({
      name: "query_metrics",
      arguments: {
        service: "checkout",
        metric: "http_5xx_rate",
        window: "2h",
        step: "1m",
        agg: "avg",
      },
    });
    const metricsPayload = JSON.parse(textOf(metrics)) as {
      bucketCount: number;
      points: Array<{ timestamp: string; value: number }>;
    };
    const values = metricsPayload.points.map((point) => point.value);
    console.log(
      `[spike] query_metrics devolvio ${metricsPayload.bucketCount} puntos ` +
        `(checkout/http_5xx_rate, 2h, step 1m, avg); ` +
        `min=${Math.min(...values).toFixed(4)} max=${Math.max(...values).toFixed(4)}`,
    );
    console.log(
      `[spike] ok en ${(performance.now() - startedAt).toFixed(0)} ms`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("[spike] fallo:", error);
  process.exitCode = 1;
});
