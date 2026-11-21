import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Los tests leen el .env de la raiz si existe; sin DATABASE_URL se saltan.
// Requieren un seed reciente: las tools miran ventanas relativas a now(), asi que las
// filas de logs de las ultimas 24h solo existen si `pnpm db:seed` se ejecuto con ancla
// actual (o `SEED_ANCHOR_ISO` dentro de las ultimas 24h).
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

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return JSON.parse(textOf(result)) as T;
  }

  it("descubre las 10 tools de lectura y las 3 de escritura del plan", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_deploys",
      "get_feature_flags",
      "get_oncall",
      "get_service",
      "get_trace_summary",
      "list_alerts",
      "list_services",
      "propose_rollback",
      "propose_set_flag",
      "propose_silence_alert",
      "query_metrics",
      "search_logs",
      "search_runbooks",
    ]);
  });

  it("list_services devuelve los 6 servicios sembrados", async () => {
    const payload = await call<{ services: Array<{ slug: string; dependsOn: string[] }> }>(
      "list_services",
      {},
    );
    expect(payload.services.map((service) => service.slug)).toEqual([
      "api",
      "checkout",
      "edge",
      "inventory",
      "payments",
      "web",
    ]);
    const checkout = payload.services.find((service) => service.slug === "checkout");
    expect(checkout?.dependsOn).toEqual(["inventory", "payments"]);
  });

  it("get_service devuelve SLO y dependencias", async () => {
    const payload = await call<{
      slug: string;
      tier: string;
      slo: { availability: string };
      dependsOn: string[];
    }>("get_service", { name: "checkout" });
    expect(payload.slug).toBe("checkout");
    expect(payload.tier).toBe("critical");
    expect(payload.slo.availability).toBe("99.95");
    expect(payload.dependsOn).toEqual(["inventory", "payments"]);
  });

  it("query_metrics devuelve puntos dentro del limite de 300", async () => {
    const payload = await call<{ points: Array<{ timestamp: string; value: number }> }>(
      "query_metrics",
      { service: "checkout", metric: "http_5xx_rate", window: "2h", step: "1m", agg: "avg" },
    );
    expect(payload.points.length).toBeGreaterThan(0);
    expect(payload.points.length).toBeLessThanOrEqual(300);
    expect(typeof payload.points[0]?.value).toBe("number");
  });

  it("search_logs respeta el limite y no devuelve PII ni tokens", async () => {
    const payload = await call<{
      returned: number;
      redactions: number;
      lines: Array<{ level: string; message: string; fields: unknown }>;
    }>("search_logs", {
      service: "checkout",
      query: "psp",
      window: "24h",
      level: "error",
      limit: 10,
    });

    expect(payload.returned).toBeGreaterThan(0);
    expect(payload.returned).toBeLessThanOrEqual(10);
    expect(typeof payload.redactions).toBe("number");

    const serialized = JSON.stringify(payload.lines);
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/sk_live_[A-Za-z0-9]+/);
    expect(serialized).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });

  it("las lineas con inyeccion de prompt se devuelven como datos", async () => {
    const payload = await call<{ lines: Array<{ message: string }> }>("search_logs", {
      service: "checkout",
      query: "ignore previous instructions",
      window: "24h",
      limit: 5,
    });
    expect(payload.lines.length).toBeGreaterThan(0);
    expect(payload.lines[0]?.message).toContain("propose_rollback");
  });

  it("get_deploys incluye el 1.42.0 que precede al incidente", async () => {
    // Ventana maxima: el test no debe depender de a que hora se sembro el dataset.
    const payload = await call<{ deploys: Array<{ version: string; deployedAt: string }> }>(
      "get_deploys",
      { service: "checkout", window: "720h" },
    );
    const star = payload.deploys.find((deploy) => deploy.version === "1.42.0");
    expect(star).toBeDefined();
    expect(payload.deploys[0]?.version).toBe("1.42.0");
  });

  it("get_trace_summary separa dependencias instrumentadas de externas", async () => {
    const checkout = await call<{
      downstreams: Array<{ name: string; instrumented: boolean; latencyP95Ms: number | null }>;
    }>("get_trace_summary", { service: "checkout", window: "1h" });
    expect(checkout.downstreams.map((downstream) => downstream.name)).toEqual([
      "inventory",
      "payments",
    ]);
    expect(checkout.downstreams.every((downstream) => downstream.instrumented)).toBe(true);

    const api = await call<{ downstreams: Array<{ name: string; instrumented: boolean }> }>(
      "get_trace_summary",
      { service: "api", window: "1h" },
    );
    const external = api.downstreams.filter((downstream) => !downstream.instrumented);
    expect(external.map((downstream) => downstream.name).sort()).toEqual(["auth", "catalog"]);
  });

  it("list_alerts filtra por servicio y estado", async () => {
    const firing = await call<{ alerts: Array<{ service: string; status: string }> }>(
      "list_alerts",
      { service: "checkout", status: "firing", window: "24h" },
    );
    expect(firing.alerts.length).toBeGreaterThan(0);
    expect(firing.alerts.every((alert) => alert.service === "checkout")).toBe(true);
    expect(firing.alerts.every((alert) => alert.status === "firing")).toBe(true);
  });

  it("get_feature_flags devuelve flags y su historial", async () => {
    const payload = await call<{
      flags: Array<{ key: string; recentChanges: unknown[] }>;
    }>("get_feature_flags", { service: "checkout" });
    expect(payload.flags).toHaveLength(3);
    expect(payload.flags.every((flag) => flag.recentChanges.length > 0)).toBe(true);
  });

  it("get_oncall devuelve primario y politica de escalado", async () => {
    const payload = await call<{
      primary: { handle: string };
      escalationMinutes: number[];
    }>("get_oncall", { service: "checkout" });
    expect(payload.primary.handle).toMatch(/^@/);
    expect(payload.escalationMinutes).toEqual([5, 15, 30]);
  });

  it("search_runbooks encuentra el runbook de checkout", async () => {
    const payload = await call<{ runbooks: Array<{ title: string; bodyMd: string }> }>(
      "search_runbooks",
      { query: "rollback" },
    );
    expect(payload.runbooks.length).toBeGreaterThan(0);
    expect(payload.runbooks[0]?.bodyMd).toContain("rollback");
    expect(payload.runbooks.length).toBeLessThanOrEqual(5);
  });

  it("una tool con argumentos invalidos falla sin cerrar la conexion", async () => {
    const result = await client.callTool({
      name: "query_metrics",
      arguments: { service: "checkout", metric: "http_5xx_rate", window: "48h", step: "1m" },
    });
    expect(result.isError).toBe(true);

    const after = await call<{ services: unknown[] }>("list_services", {});
    expect(after.services).toHaveLength(6);
  });

  // --- Escrituras en dos fases (ADR-004) ---------------------------------------

  it("propose_rollback devuelve el plan sin mutar nada", async () => {
    const payload = await call<{
      kind: string;
      target: string;
      risk: string;
      diff: { kind: string; from_version: string; to_version: string };
      blast_radius: { service: string; dependents: string[] };
      evidence: string[];
    }>("propose_rollback", {
      service: "checkout",
      to_version: "1.41.0",
      reason: "pico de 5xx",
    });

    expect(payload.kind).toBe("rollback");
    expect(payload.target).toBe("checkout");
    expect(payload.risk).toBe("alto");
    expect(payload.diff.kind).toBe("rollback");
    expect(payload.diff.to_version).toBe("1.41.0");
    expect(payload.diff.from_version).not.toBe("1.41.0");
    expect(payload.blast_radius.service).toBe("checkout");
    expect(payload.evidence.length).toBeGreaterThan(0);
  });

  it("propose_rollback falla si la version no existe", async () => {
    const result = await client.callTool({
      name: "propose_rollback",
      arguments: { service: "checkout", to_version: "9.9.9", reason: "no existe" },
    });
    expect(result.isError).toBe(true);
  });

  it("propose_set_flag devuelve el valor actual y el propuesto", async () => {
    const payload = await call<{
      kind: string;
      diff: { kind: string; from_value: string; to_value: string; service: string };
    }>("propose_set_flag", {
      flag: "checkout.confirm.async",
      value: true,
      reason: "el rollout nuevo falla",
    });

    expect(payload.kind).toBe("set_flag");
    expect(payload.diff.from_value).toBe("false");
    expect(payload.diff.to_value).toBe("true");
    expect(payload.diff.service).toBe("checkout");
  });

  it("propose_silence_alert calcula hasta cuando se silencia", async () => {
    const alerts = await call<{ alerts: Array<{ id: string; service: string }> }>(
      "list_alerts",
      { service: "checkout", status: "firing", window: "24h" },
    );
    const alert = alerts.alerts[0];
    expect(alert).toBeDefined();

    const payload = await call<{
      kind: string;
      diff: { kind: string; alert_id: string; duration_seconds: number; silenced_until: string };
    }>("propose_silence_alert", {
      alert_id: alert?.id ?? "0",
      duration: "30m",
      reason: "falsa alarma",
    });

    expect(payload.kind).toBe("silence_alert");
    expect(payload.diff.alert_id).toBe(alert?.id);
    expect(payload.diff.duration_seconds).toBe(1800);
    expect(payload.diff.silenced_until).toMatch(/Z$/);
  });
});