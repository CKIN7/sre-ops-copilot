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

    const services = JSON.parse(
      textOf(await client.callTool({ name: "list_services", arguments: {} })),
    ) as { services: Array<{ slug: string }> };
    console.log(
      `[spike] list_services -> ${services.services.length} servicios: ${services.services
        .map((service) => service.slug)
        .join(", ")}`,
    );

    const service = JSON.parse(
      textOf(await client.callTool({ name: "get_service", arguments: { name: "checkout" } })),
    ) as { dependsOn: string[]; slo: { availability: string } };
    console.log(
      `[spike] get_service checkout -> deps ${service.dependsOn.join(", ")}; ` +
        `SLO ${service.slo.availability}%`,
    );

    const metrics = JSON.parse(
      textOf(
        await client.callTool({
          name: "query_metrics",
          arguments: {
            service: "checkout",
            metric: "http_5xx_rate",
            window: "2h",
            step: "1m",
            agg: "avg",
          },
        }),
      ),
    ) as { bucketCount: number; points: Array<{ value: number }> };
    const values = metrics.points.map((point) => point.value);
    console.log(
      `[spike] query_metrics -> ${metrics.bucketCount} puntos; min=${Math.min(...values).toFixed(
        4,
      )} max=${Math.max(...values).toFixed(4)}`,
    );

    const logs = JSON.parse(
      textOf(
        await client.callTool({
          name: "search_logs",
          arguments: { service: "checkout", query: "psp", window: "1h", level: "error", limit: 20 },
        }),
      ),
    ) as { returned: number; redactions: number; lines: Array<{ message: string }> };
    const leaked = logs.lines.filter(
      (line) => /@|sk_live_|Bearer\s+[A-Za-z0-9]/.test(line.message),
    );
    console.log(
      `[spike] search_logs -> ${logs.returned} lineas, ${logs.redactions} redacciones, ` +
        `${leaked.length} fugas`,
    );

    const deploys = JSON.parse(
      textOf(
        await client.callTool({
          name: "get_deploys",
          arguments: { service: "checkout", window: "168h" },
        }),
      ),
    ) as { deploys: Array<{ version: string; deployedAt: string }> };
    const latest = deploys.deploys[0];
    console.log(
      `[spike] get_deploys -> ${deploys.deploys.length} deploys; ultimo ` +
        `${latest?.version ?? "?"} a las ${latest?.deployedAt ?? "?"}`,
    );

    const trace = JSON.parse(
      textOf(
        await client.callTool({
          name: "get_trace_summary",
          arguments: { service: "checkout", window: "1h" },
        }),
      ),
    ) as { downstreams: Array<{ name: string; instrumented: boolean }> };
    console.log(
      `[spike] get_trace_summary -> ${trace.downstreams
        .map((downstream) => `${downstream.name}${downstream.instrumented ? "" : " (externo)"}`)
        .join(", ")}`,
    );

    const alerts = JSON.parse(
      textOf(
        await client.callTool({
          name: "list_alerts",
          arguments: { service: "checkout", window: "24h" },
        }),
      ),
    ) as { alerts: Array<{ status: string }> };
    const firing = alerts.alerts.filter((alert) => alert.status === "firing").length;
    console.log(`[spike] list_alerts -> ${alerts.alerts.length} alertas (${firing} firing)`);

    const flags = JSON.parse(
      textOf(
        await client.callTool({ name: "get_feature_flags", arguments: { service: "checkout" } }),
      ),
    ) as { flags: Array<{ key: string }> };
    console.log(
      `[spike] get_feature_flags -> ${flags.flags.length} flags: ${flags.flags
        .map((flag) => flag.key)
        .join(", ")}`,
    );

    const oncall = JSON.parse(
      textOf(await client.callTool({ name: "get_oncall", arguments: { service: "checkout" } })),
    ) as { primary: { handle: string } };
    console.log(`[spike] get_oncall -> primario ${oncall.primary.handle}`);

    const runbooks = JSON.parse(
      textOf(
        await client.callTool({ name: "search_runbooks", arguments: { query: "checkout" } }),
      ),
    ) as { runbooks: Array<{ title: string }> };
    console.log(
      `[spike] search_runbooks -> ${runbooks.runbooks.length} coincidencias ` +
        `(${runbooks.runbooks.map((runbook) => runbook.title).join("; ")})`,
    );

    console.log(`[spike] ok en ${(performance.now() - startedAt).toFixed(0)} ms`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("[spike] fallo:", error);
  process.exitCode = 1;
});
