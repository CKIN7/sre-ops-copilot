import { describe, expect, it } from "vitest";

import {
  ALERT_COUNT,
  FEATURE_FLAGS,
  LOG_LINE_COUNT,
  PROMPT_INJECTION_LINES,
  STAR_DEPLOY_OFFSET_MINUTES,
  STAR_DEPLOY_VERSION,
  buildAlerts,
  buildDeploys,
  buildFeatureFlags,
  buildOncall,
  buildPromptInjectionLogs,
  buildRunbooks,
  incidentWindowForAnchor,
  logLineAt,
} from "../src/generator.js";

const ANCHOR_MS = Date.parse("2026-11-10T15:07:00Z");
const INCIDENT = incidentWindowForAnchor(ANCHOR_MS);

describe("deploys", () => {
  const deploys = buildDeploys(ANCHOR_MS);

  it("siembra 40 deploys con versiones unicas por servicio", () => {
    expect(deploys).toHaveLength(40);
    const keys = deploys.map((deploy) => `${deploy.slug}@${deploy.version}`);
    expect(new Set(keys).size).toBe(deploys.length);
  });

  it("el deploy 1.42.0 de checkout precede al incidente en 18 min", () => {
    const star = deploys.find(
      (deploy) => deploy.slug === "checkout" && deploy.version === STAR_DEPLOY_VERSION,
    );
    expect(star).toBeDefined();
    expect(star?.deployedAtMs).toBe(INCIDENT.startMs - STAR_DEPLOY_OFFSET_MINUTES * 60_000);
  });

  it("es determinista", () => {
    expect(buildDeploys(ANCHOR_MS)).toEqual(deploys);
  });
});

describe("alertas", () => {
  const alerts = buildAlerts(ANCHOR_MS);

  it("siembra 60 alertas", () => {
    expect(alerts).toHaveLength(ALERT_COUNT);
  });

  it("deja una alerta de checkout activa dentro del incidente", () => {
    const incidentAlert = alerts.find(
      (alert) =>
        alert.slug === "checkout" &&
        alert.status === "firing" &&
        alert.startedAtMs >= INCIDENT.startMs &&
        alert.startedAtMs <= INCIDENT.endMs,
    );
    expect(incidentAlert).toBeDefined();
    expect(incidentAlert?.name).toBe("Checkout5xxRateHigh");
  });

  it("incluye una alerta falsa de backlog que el dataset desmiente", () => {
    const falseAlert = alerts.find(
      (alert) => alert.slug === "inventory" && alert.summary.includes("500"),
    );
    expect(falseAlert).toBeDefined();
    expect(falseAlert?.status).toBe("firing");
  });
});

describe("logs", () => {
  it("declara 200k lineas y 3 inyecciones de prompt", () => {
    expect(LOG_LINE_COUNT).toBe(200_000);
    expect(PROMPT_INJECTION_LINES).toHaveLength(3);
  });

  it("la misma linea se repite con el mismo indice", () => {
    expect(logLineAt(12_345, ANCHOR_MS)).toEqual(logLineAt(12_345, ANCHOR_MS));
  });

  it("produce lineas con PII y con tokens para que la redaccion tenga trabajo", () => {
    const sample = Array.from({ length: 5000 }, (_, index) => logLineAt(index, ANCHOR_MS));
    expect(sample.some((line) => line.message.includes("@"))).toBe(true);
    expect(sample.some((line) => line.message.includes("sk_live_"))).toBe(true);
    expect(
      sample.some((line) => /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(line.message)),
    ).toBe(true);
  });

  it("ancla las inyecciones dentro del incidente", () => {
    const injections = buildPromptInjectionLogs(ANCHOR_MS);
    expect(injections).toHaveLength(3);
    for (const line of injections) {
      expect(line.slug).toBe("checkout");
      expect(line.tsMs).toBeGreaterThan(INCIDENT.startMs);
      expect(line.tsMs).toBeLessThan(INCIDENT.endMs);
    }
  });
});

describe("flags, runbooks y guardias", () => {
  it("siembra 12 flags con dos cambios cada una", () => {
    const { flags, changes } = buildFeatureFlags(ANCHOR_MS);
    expect(flags).toHaveLength(FEATURE_FLAGS.length);
    expect(flags).toHaveLength(12);
    expect(changes).toHaveLength(24);
  });

  it("siembra un runbook por servicio mas dos transversales", () => {
    const runbooks = buildRunbooks(ANCHOR_MS);
    expect(runbooks).toHaveLength(8);
    expect(runbooks.filter((runbook) => runbook.slug === null)).toHaveLength(2);
  });

  it("siembra una guardia por servicio con escalado 5/15/30", () => {
    const oncall = buildOncall();
    expect(oncall).toHaveLength(6);
    expect(new Set(oncall.map((row) => row.slug)).size).toBe(6);
    for (const row of oncall) {
      expect(row.escalationMinutes).toEqual([5, 15, 30]);
    }
  });
});