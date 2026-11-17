import { describe, expect, it } from "vitest";

import { METRIC_NAMES, METRICS } from "../src/domain/metrics.js";
import { SERVICE_SLUGS, SERVICES } from "../src/domain/services.js";

const SEED_DAYS = 30;
const MINUTES_PER_DAY = 1440;
const EXPECTED_FULL_SEED_POINTS = 3_110_400;

describe("inventario sembrado", () => {
  it("tiene los 6 servicios del guion", () => {
    expect(SERVICES.map((service) => service.slug)).toEqual([...SERVICE_SLUGS]);
    expect(new Set(SERVICE_SLUGS).size).toBe(6);
  });

  it("cada servicio declara dependencias sin duplicados", () => {
    for (const service of SERVICES) {
      expect(service.dependsOn.length).toBeGreaterThan(0);
      expect(new Set(service.dependsOn).size).toBe(service.dependsOn.length);
    }
  });

  it("el catalogo cubre los 12 nombres de metrica sin duplicados", () => {
    expect(METRIC_NAMES).toHaveLength(12);
    expect(METRICS).toHaveLength(12);
    expect(METRICS.map((metric) => metric.name)).toEqual([...METRIC_NAMES]);
  });

  it("el seed a escala 1 son 3.110.400 puntos", () => {
    const total =
      SERVICES.length * METRIC_NAMES.length * (SEED_DAYS * MINUTES_PER_DAY);
    expect(total).toBe(EXPECTED_FULL_SEED_POINTS);
  });
});
