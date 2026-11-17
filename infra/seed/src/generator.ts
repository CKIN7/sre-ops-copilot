import { METRIC_NAMES, type MetricName } from "@beacon/core/domain/metrics";
import type { ServiceSlug } from "@beacon/core/domain/services";

export const SEED_DAYS = 30;
export const MINUTES_PER_DAY = 1440;
export const SEED_NAMESPACE = "beacon-shop-v1";

export const INCIDENT_SERVICE: ServiceSlug = "checkout";
export const INCIDENT_METRIC: MetricName = "http_5xx_rate";
export const INCIDENT_START_MINUTES_BEFORE_ANCHOR = 38;
export const INCIDENT_RAMP_MINUTES = 5;
export const INCIDENT_5XX_BASELINE = 0.004;
export const INCIDENT_5XX_ELEVATION = 0.037;
export const INCIDENT_P99_MULTIPLIER = 1.75;

interface ServiceProfile {
  rps: number;
  latencyP50: number;
  latencyP99: number;
  cpu: number;
  mem: number;
  dbPoolMax: number;
  queueDepth: number;
  downstreamLatency: number;
}

const PROFILES: Record<ServiceSlug, ServiceProfile> = {
  edge: {
    rps: 820,
    latencyP50: 18,
    latencyP99: 95,
    cpu: 38,
    mem: 512,
    dbPoolMax: 40,
    queueDepth: 12,
    downstreamLatency: 22,
  },
  web: {
    rps: 410,
    latencyP50: 42,
    latencyP99: 240,
    cpu: 44,
    mem: 768,
    dbPoolMax: 20,
    queueDepth: 4,
    downstreamLatency: 38,
  },
  api: {
    rps: 620,
    latencyP50: 28,
    latencyP99: 180,
    cpu: 52,
    mem: 1024,
    dbPoolMax: 60,
    queueDepth: 18,
    downstreamLatency: 30,
  },
  checkout: {
    rps: 120,
    latencyP50: 55,
    latencyP99: 310,
    cpu: 48,
    mem: 896,
    dbPoolMax: 30,
    queueDepth: 9,
    downstreamLatency: 65,
  },
  payments: {
    rps: 95,
    latencyP50: 70,
    latencyP99: 420,
    cpu: 35,
    mem: 640,
    dbPoolMax: 10,
    queueDepth: 6,
    downstreamLatency: 90,
  },
  inventory: {
    rps: 150,
    latencyP50: 24,
    latencyP99: 140,
    cpu: 31,
    mem: 384,
    dbPoolMax: 25,
    queueDepth: 7,
    downstreamLatency: 18,
  },
};

export interface IncidentWindow {
  startMs: number;
  endMs: number;
}

/** Ventana del incidente estrella: empieza 38 min antes del fin de la ventana y sigue abierta. */
export function incidentWindowForAnchor(anchorMs: number): IncidentWindow {
  return {
    startMs: anchorMs - INCIDENT_START_MINUTES_BEFORE_ANCHOR * 60_000,
    endMs: anchorMs,
  };
}

/**
 * Escala el muestreo sin cambiar la forma del dataset: 1 = 1 min, 0.5 = 2 min,
 * 0.1 = 10 min. Valores mayores que 1 se recortan a 1.
 */
export function stepMinutesForScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("SEED_SCALE must be a finite number greater than 0");
  }
  return Math.max(1, Math.round(1 / Math.min(scale, 1)));
}

export function pointsPerSeriesForScale(scale: number): number {
  return (SEED_DAYS * MINUTES_PER_DAY) / stepMinutesForScale(scale);
}

function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** PRNG determinista en [0, 1) derivado de una clave estable. */
function unitFromKey(key: string): number {
  const state = (hash32(key) + 0x6d2b79f5) | 0;
  let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function metricValueAt(
  slug: ServiceSlug,
  metric: MetricName,
  epochMinute: number,
  incident: IncidentWindow,
): number {
  const profile = PROFILES[slug];
  const minuteOfDay = ((epochMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const diurnal = 0.7 + 0.3 * Math.sin(((minuteOfDay - 720) / MINUTES_PER_DAY) * Math.PI * 2);
  const noise = unitFromKey(`${SEED_NAMESPACE}|${slug}|${metric}|${epochMinute}`);
  const jitter = 0.9 + 0.2 * noise;

  const pointMs = epochMinute * 60_000;
  const inIncident = pointMs >= incident.startMs && pointMs < incident.endMs;
  const incidentService = slug === INCIDENT_SERVICE;
  const ramp = clamp(
    (pointMs - incident.startMs) / (INCIDENT_RAMP_MINUTES * 60_000),
    0,
    1,
  );

  switch (metric) {
    case "rps":
      return round3(profile.rps * diurnal * jitter);
    case "latency_p50":
      return round3(profile.latencyP50 * jitter);
    case "latency_p95":
      return round3(profile.latencyP50 * 2.4 * jitter);
    case "latency_p99":
      return round3(
        profile.latencyP99 * jitter * (incidentService && inIncident ? INCIDENT_P99_MULTIPLIER : 1),
      );
    case "http_5xx_rate": {
      const baseline = INCIDENT_5XX_BASELINE * (0.7 + 0.6 * noise);
      if (incidentService && inIncident) {
        return round3(baseline + INCIDENT_5XX_ELEVATION * ramp);
      }
      return round3(baseline);
    }
    case "cpu":
      return round3(clamp(profile.cpu * diurnal * jitter, 3, 96));
    case "mem":
      return round3(profile.mem * (0.97 + 0.06 * noise));
    case "gc_pause":
      return round3(6 + 18 * noise);
    case "db_pool_used":
      return Math.round(profile.dbPoolMax * (0.45 + 0.3 * noise));
    case "db_pool_max":
      return profile.dbPoolMax;
    case "queue_depth":
      return Math.round(profile.queueDepth * diurnal * (0.4 + 0.6 * noise));
    case "latency_downstream":
      return round3(profile.downstreamLatency * jitter);
  }
}

export function assertMetricCatalogComplete(): void {
  if (METRIC_NAMES.length !== 12) {
    throw new Error(`expected 12 metrics, got ${METRIC_NAMES.length}`);
  }
}
