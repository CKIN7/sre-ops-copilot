import { describe, expect, it } from "vitest";

import {
  READ_TOOL_NAMES,
  getDeploysInputSchema,
  getServiceInputSchema,
  listAlertsInputSchema,
  listServicesInputSchema,
  queryMetricsInputSchema,
  searchLogsInputSchema,
  searchRunbooksInputSchema,
} from "../src/schemas/tools.js";

const VALID_QUERY = {
  service: "checkout",
  metric: "http_5xx_rate",
  window: "2h",
  step: "1m",
} as const;

describe("listServicesInputSchema", () => {
  it("acepta un objeto vacio", () => {
    expect(listServicesInputSchema.parse({})).toEqual({});
  });
});

describe("getServiceInputSchema", () => {
  it("acepta un slug y rechaza nombres con mayusculas", () => {
    expect(getServiceInputSchema.parse({ name: "checkout" })).toEqual({ name: "checkout" });
    expect(getServiceInputSchema.safeParse({ name: "Checkout" }).success).toBe(false);
  });
});

describe("queryMetricsInputSchema", () => {
  it("acepta una consulta valida y aplica avg por defecto", () => {
    const parsed = queryMetricsInputSchema.parse(VALID_QUERY);
    expect(parsed.agg).toBe("avg");
  });

  it("rechaza metricas fuera del catalogo", () => {
    expect(
      queryMetricsInputSchema.safeParse({ ...VALID_QUERY, metric: "invented_metric" }).success,
    ).toBe(false);
  });

  it("rechaza ventanas mayores a 24h", () => {
    expect(queryMetricsInputSchema.safeParse({ ...VALID_QUERY, window: "25h" }).success).toBe(
      false,
    );
  });

  it("rechaza ventanas menores a 1 minuto", () => {
    expect(queryMetricsInputSchema.safeParse({ ...VALID_QUERY, window: "30s" }).success).toBe(
      false,
    );
  });

  it("rechaza mas de 300 puntos", () => {
    expect(
      queryMetricsInputSchema.safeParse({ ...VALID_QUERY, window: "24h", step: "10s" }).success,
    ).toBe(false);
  });

  it("rechaza un step mayor que la ventana", () => {
    expect(
      queryMetricsInputSchema.safeParse({ ...VALID_QUERY, window: "30m", step: "1h" }).success,
    ).toBe(false);
  });

  it("rechaza slugs de servicio invalidos", () => {
    expect(
      queryMetricsInputSchema.safeParse({ ...VALID_QUERY, service: "Checkout!" }).success,
    ).toBe(false);
  });
});

describe("searchLogsInputSchema", () => {
  const valid = { service: "checkout", query: "psp", window: "1h" };

  it("aplica 20 lineas por defecto y acepta el maximo de 50", () => {
    expect(searchLogsInputSchema.parse(valid).limit).toBe(20);
    expect(searchLogsInputSchema.safeParse({ ...valid, limit: 50 }).success).toBe(true);
  });

  it("rechaza mas de 50 lineas y niveles fuera del enum", () => {
    expect(searchLogsInputSchema.safeParse({ ...valid, limit: 51 }).success).toBe(false);
    expect(searchLogsInputSchema.safeParse({ ...valid, level: "fatal" }).success).toBe(false);
  });

  it("rechaza ventanas mayores a 24h", () => {
    expect(searchLogsInputSchema.safeParse({ ...valid, window: "7d" }).success).toBe(false);
  });

  it("rechaza una query vacia", () => {
    expect(searchLogsInputSchema.safeParse({ ...valid, query: "" }).success).toBe(false);
  });
});

describe("getDeploysInputSchema", () => {
  it("acepta hasta 30 dias y rechaza mas", () => {
    expect(
      getDeploysInputSchema.safeParse({ service: "checkout", window: "720h" }).success,
    ).toBe(true);
    expect(
      getDeploysInputSchema.safeParse({ service: "checkout", window: "721h" }).success,
    ).toBe(false);
  });
});

describe("listAlertsInputSchema", () => {
  it("acepta filtros opcionales y rechaza estados inventados", () => {
    expect(
      listAlertsInputSchema.safeParse({ service: "checkout", status: "firing", window: "24h" })
        .success,
    ).toBe(true);
    expect(listAlertsInputSchema.safeParse({ window: "24h" }).success).toBe(true);
    expect(
      listAlertsInputSchema.safeParse({ status: "paged", window: "24h" }).success,
    ).toBe(false);
  });
});

describe("searchRunbooksInputSchema", () => {
  it("exige al menos dos caracteres", () => {
    expect(searchRunbooksInputSchema.safeParse({ query: "rollback" }).success).toBe(true);
    expect(searchRunbooksInputSchema.safeParse({ query: "r" }).success).toBe(false);
  });
});

describe("superficie de lectura", () => {
  it("declara exactamente las 10 tools del plan", () => {
    expect([...READ_TOOL_NAMES].sort()).toEqual([
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
});
