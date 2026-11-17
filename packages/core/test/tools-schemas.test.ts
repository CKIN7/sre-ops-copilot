import { describe, expect, it } from "vitest";

import { listServicesInputSchema, queryMetricsInputSchema } from "../src/schemas/tools.js";

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

describe("queryMetricsInputSchema", () => {
  it("acepta una consulta valida y aplica avg por defecto", () => {
    const parsed = queryMetricsInputSchema.parse(VALID_QUERY);
    expect(parsed.agg).toBe("avg");
  });

  it("rechaza metricas fuera del catalogo", () => {
    const result = queryMetricsInputSchema.safeParse({
      ...VALID_QUERY,
      metric: "invented_metric",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza ventanas mayores a 24h", () => {
    const result = queryMetricsInputSchema.safeParse({ ...VALID_QUERY, window: "25h" });
    expect(result.success).toBe(false);
  });

  it("rechaza ventanas menores a 1 minuto", () => {
    const result = queryMetricsInputSchema.safeParse({ ...VALID_QUERY, window: "30s" });
    expect(result.success).toBe(false);
  });

  it("rechaza mas de 300 puntos", () => {
    const result = queryMetricsInputSchema.safeParse({
      ...VALID_QUERY,
      window: "24h",
      step: "10s",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza un step mayor que la ventana", () => {
    const result = queryMetricsInputSchema.safeParse({
      ...VALID_QUERY,
      window: "30m",
      step: "1h",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza slugs de servicio invalidos", () => {
    const result = queryMetricsInputSchema.safeParse({
      ...VALID_QUERY,
      service: "Checkout!",
    });
    expect(result.success).toBe(false);
  });
});
