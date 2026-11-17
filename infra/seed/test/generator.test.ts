import { METRIC_NAMES } from "@beacon/core/domain/metrics";
import { SERVICES } from "@beacon/core/domain/services";
import { describe, expect, it } from "vitest";

import {
  MINUTES_PER_DAY,
  SEED_DAYS,
  incidentWindowForAnchor,
  metricValueAt,
  pointsPerSeriesForScale,
  stepMinutesForScale,
} from "../src/generator.js";

const ANCHOR_MS = Date.parse("2026-11-10T15:07:00Z");
const ANCHOR_MINUTE = ANCHOR_MS / 60_000;
const INCIDENT = incidentWindowForAnchor(ANCHOR_MS);

describe("generador determinista", () => {
  it("repite el mismo valor para el mismo servicio, metrica y minuto", () => {
    for (const metric of METRIC_NAMES) {
      const first = metricValueAt("checkout", metric, ANCHOR_MINUTE - 120, INCIDENT);
      const second = metricValueAt("checkout", metric, ANCHOR_MINUTE - 120, INCIDENT);
      expect(second).toBe(first);
    }
  });

  it("mapea SEED_SCALE al paso de muestreo", () => {
    expect(stepMinutesForScale(1)).toBe(1);
    expect(stepMinutesForScale(0.5)).toBe(2);
    expect(stepMinutesForScale(0.1)).toBe(10);
    expect(stepMinutesForScale(0.02)).toBe(50);
    expect(stepMinutesForScale(2)).toBe(1);
    expect(() => stepMinutesForScale(0)).toThrow("SEED_SCALE");
  });

  it("el seed a escala 1 son 3.110.400 puntos", () => {
    expect(SERVICES.length).toBe(6);
    expect(METRIC_NAMES.length).toBe(12);
    expect(pointsPerSeriesForScale(1)).toBe(SEED_DAYS * MINUTES_PER_DAY);
    expect(pointsPerSeriesForScale(1) * SERVICES.length * METRIC_NAMES.length).toBe(3_110_400);
  });

  it("no genera valores negativos ni fuera de rango", () => {
    for (const metric of METRIC_NAMES) {
      for (let offset = 0; offset < 240; offset += 7) {
        const value = metricValueAt("checkout", metric, ANCHOR_MINUTE - offset, INCIDENT);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    expect(metricValueAt("checkout", "http_5xx_rate", ANCHOR_MINUTE, INCIDENT)).toBeLessThanOrEqual(1);
    expect(metricValueAt("checkout", "cpu", ANCHOR_MINUTE, INCIDENT)).toBeLessThanOrEqual(100);
  });

  it("el incidente elevado solo afecta a checkout y solo dentro de la ventana", () => {
    const inWindow = metricValueAt("checkout", "http_5xx_rate", ANCHOR_MINUTE - 10, INCIDENT);
    const beforeWindow = metricValueAt("checkout", "http_5xx_rate", ANCHOR_MINUTE - 60, INCIDENT);
    const otherService = metricValueAt("edge", "http_5xx_rate", ANCHOR_MINUTE - 10, INCIDENT);

    expect(inWindow).toBeGreaterThan(0.02);
    expect(beforeWindow).toBeLessThan(0.01);
    expect(otherService).toBeLessThan(0.01);
  });
});
