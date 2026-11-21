import { parseDurationSeconds } from "@beacon/core/domain/duration";
import { METRIC_NAMES } from "@beacon/core/domain/metrics";
import { SERVICES, type ServiceSlug } from "@beacon/core/domain/services";
import { redactText, redactValue } from "@beacon/core/redaction/redact";
import { ALL_TOOL_INPUT_SCHEMAS, type ToolName } from "@beacon/core/schemas/tools";
import {
  buildAlerts,
  buildDeploys,
  buildFeatureFlags,
  buildOncall,
  buildPromptInjectionLogs,
  buildRunbooks,
  incidentWindowForAnchor,
  logLineAt,
  LOG_LINE_COUNT,
  metricValueAt,
  type LogSeed,
} from "@beacon/seed/generator";

import { goldenCases } from "../cases/golden-set.js";
import { defaultCatalog, resolveCapability } from "../harness/catalog.js";
import type { FixtureEntry, FixtureFile } from "./format.js";

/**
 * Generador de fixtures del golden set a partir del **mismo** generador determinista
 * del seed (`@beacon/seed/generator`), sin Postgres.
 *
 * Por que existe: el grabador contra la base (`evals:record` con `DATABASE_URL`) es
 * el camino normal, pero el gate de CI no puede depender de una base ni de que el
 * seed sea reciente. Estas fixtures fijan un ancla y un "ahora" concretos y
 * reproducen las respuestas de las tools con las formulas del seed. No son datos
 * inventados: son el dataset sembrado evaluado en un instante fijo.
 *
 * Limitacion honesta: no reproducen el SQL de agregacion al bit (por ejemplo,
 * `date_bin` con origenes distintos). Los valores son los del generador en pasos de
 * 10 minutos; si hace falta fidelidad exacta, se re-graba con `pnpm evals:record`.
 */
export const FIXTURE_SEED_ANCHOR_MS = Date.parse("2026-11-21T18:24:00.000Z");
export const FIXTURE_RECORDED_NOW_MS = Date.parse("2026-11-21T20:38:00.000Z");
const STEP_MINUTES = 10;
const STEP_MS = STEP_MINUTES * 60_000;

function seedServices() {
  return SERVICES;
}

function serviceOf(slug: string) {
  return seedServices().find((service) => service.slug === slug);
}

function blastRadiusOf(slug: string) {
  const service = serviceOf(slug);
  const dependents = seedServices()
    .filter((candidate) => candidate.dependsOn.includes(slug))
    .map((candidate) => candidate.slug)
    .sort();
  return {
    service: slug,
    tier: service?.tier ?? "unknown",
    owner_team: service?.ownerTeam ?? "unknown",
    dependents,
    dependency_count: dependents.length,
  };
}

function windowSeconds(window: string): number {
  return parseDurationSeconds(window);
}

function metricPoints(
  slug: string,
  metric: (typeof METRIC_NAMES)[number],
  window: string,
): Array<{ timestamp: string; value: number }> {
  const startMs = FIXTURE_RECORDED_NOW_MS - windowSeconds(window) * 1000;
  const first = Math.ceil(startMs / STEP_MS) * STEP_MS;
  const incident = incidentWindowForAnchor(FIXTURE_SEED_ANCHOR_MS);
  const points: Array<{ timestamp: string; value: number }> = [];

  for (let ts = first; ts < FIXTURE_RECORDED_NOW_MS; ts += STEP_MS) {
    const epochMinute = Math.floor(ts / 60_000);
    points.push({
      timestamp: new Date(ts).toISOString(),
      value: metricValueAt(slug as ServiceSlug, metric, epochMinute, incident),
    });
  }

  return points;
}

function queryMetricsResult(
  service: string,
  metric: string,
  window: string,
  step: string,
  agg: string,
): unknown {
  const points =
    (METRIC_NAMES as readonly string[]).includes(metric) && step === "10m"
      ? metricPoints(service, metric as (typeof METRIC_NAMES)[number], window)
      : [];

  if (agg === "avg" && points.length > 0) {
    const average =
      points.reduce((sum, point) => sum + point.value, 0) / points.length;
    return {
      service,
      metric,
      window,
      step,
      agg,
      bucketCount: 1,
      points: [{ timestamp: points[points.length - 1]?.timestamp, value: average }],
    };
  }

  return {
    service,
    metric,
    window,
    step,
    agg,
    bucketCount: points.length,
    points,
  };
}

let logCache: LogSeed[] | null = null;

function allLogs(): LogSeed[] {
  if (logCache) {
    return logCache;
  }
  const logs: LogSeed[] = [];
  for (let index = 0; index < LOG_LINE_COUNT; index += 1) {
    logs.push(logLineAt(index, FIXTURE_SEED_ANCHOR_MS));
  }
  for (const injection of buildPromptInjectionLogs(FIXTURE_SEED_ANCHOR_MS)) {
    logs.push(injection);
  }
  logCache = logs;
  return logs;
}

function searchLogsResult(
  service: string,
  query: string,
  window: string,
  level: string | null,
  limit: number,
): unknown {
  const startMs = FIXTURE_RECORDED_NOW_MS - windowSeconds(window) * 1000;
  const needle = query.toLowerCase();
  const matches = allLogs()
    .filter((line) => line.slug === service)
    .filter((line) => line.tsMs >= startMs && line.tsMs < FIXTURE_RECORDED_NOW_MS)
    .filter((line) => level === null || line.level === level)
    .filter((line) => line.message.toLowerCase().includes(needle))
    .sort((left, right) => right.tsMs - left.tsMs)
    .slice(0, limit);

  let redactions = 0;
  const lines = matches.map((line) => {
    const redacted = redactText(line.message);
    redactions += redacted.redactions;
    return {
      timestamp: new Date(line.tsMs).toISOString(),
      level: line.level,
      message: redacted.text,
      fields: redactValue(line.fields),
    };
  });

  return {
    service,
    query,
    window,
    level,
    limit,
    returned: lines.length,
    redactions,
    lines,
  };
}

function deploysFor(service: string, window: string) {
  const startMs = FIXTURE_RECORDED_NOW_MS - windowSeconds(window) * 1000;
  return buildDeploys(FIXTURE_SEED_ANCHOR_MS)
    .filter((deploy) => deploy.slug === service)
    .filter(
      (deploy) =>
        deploy.deployedAtMs >= startMs && deploy.deployedAtMs < FIXTURE_RECORDED_NOW_MS,
    )
    .sort((left, right) => right.deployedAtMs - left.deployedAtMs)
    .map((deploy) => ({
      version: deploy.version,
      commitSha: deploy.commitSha,
      author: deploy.author,
      deployedAt: new Date(deploy.deployedAtMs).toISOString(),
      diffSummary: deploy.diffSummary,
      filesChanged: deploy.filesChanged,
      rolloutStatus: deploy.rolloutStatus,
    }));
}

function traceSummaryResult(service: string, window: string): unknown {
  const serviceDef = serviceOf(service);
  const observed = metricPoints(service, "latency_downstream", window);
  const observedAverage =
    observed.length > 0
      ? observed.reduce((sum, point) => sum + point.value, 0) / observed.length
      : null;

  const downstreams = (serviceDef?.dependsOn ?? [])
    .map((downstream) => {
      const isSeeded = Boolean(serviceOf(downstream));
      if (!isSeeded) {
        return {
          name: downstream,
          kind: "sync",
          latencyP95Ms: null,
          errorRate: null,
          observedDownstreamMs: observedAverage,
          instrumented: false,
        };
      }
      const latency = metricPoints(
        downstream,
        "latency_p95",
        window,
      );
      const errors = metricPoints(downstream, "http_5xx_rate", window);
      const avg = (values: Array<{ value: number }>) =>
        values.length > 0
          ? values.reduce((sum, point) => sum + point.value, 0) / values.length
          : null;
      return {
        name: downstream,
        kind: "sync",
        latencyP95Ms: avg(latency),
        errorRate: avg(errors),
        observedDownstreamMs: observedAverage,
        instrumented: true,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return { service, window, downstreams };
}

function featureFlagsResult(service: string): unknown {
  const { flags, changes } = buildFeatureFlags(FIXTURE_SEED_ANCHOR_MS);
  const serviceFlags = flags
    .filter((flag) => flag.slug === service)
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    service,
    flags: serviceFlags.map((flag) => ({
      key: flag.key,
      description: flag.description,
      enabled: flag.enabled,
      rolloutPercent: flag.rolloutPercent,
      updatedAt: new Date(flag.updatedAtMs).toISOString(),
      updatedBy: flag.updatedBy,
      recentChanges: changes
        .filter((change) => change.flagKey === flag.key)
        .sort((left, right) => right.changedAtMs - left.changedAtMs)
        .slice(0, 3)
        .map((change) => ({
          changedAt: new Date(change.changedAtMs).toISOString(),
          changedBy: change.changedBy,
          fromValue: change.fromValue,
          toValue: change.toValue,
          reason: change.reason,
        })),
    })),
  };
}

function listAlertsResult(
  service: string | null,
  status: string | null,
  window: string,
): unknown {
  const startMs = FIXTURE_RECORDED_NOW_MS - windowSeconds(window) * 1000;
  const alerts = buildAlerts(FIXTURE_SEED_ANCHOR_MS)
    .slice()
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .map((alert, index) => ({ ...alert, id: String(index + 1) }));

  const filtered = alerts
    .filter((alert) => !service || alert.slug === service)
    .filter((alert) => !status || alert.status === status)
    .filter(
      (alert) =>
        alert.startedAtMs >= startMs && alert.startedAtMs < FIXTURE_RECORDED_NOW_MS,
    )
    .sort((left, right) => right.startedAtMs - left.startedAtMs);

  return {
    window,
    service,
    status,
    alerts: filtered.map((alert) => ({
      id: alert.id,
      name: alert.name,
      service: alert.slug,
      severity: alert.severity,
      status: alert.status,
      startedAt: new Date(alert.startedAtMs).toISOString(),
      resolvedAt:
        alert.resolvedAtMs === null ? null : new Date(alert.resolvedAtMs).toISOString(),
      summary: alert.summary,
    })),
  };
}

function oncallResult(service: string): unknown {
  const oncall = buildOncall().find((row) => row.slug === service);
  if (!oncall) {
    throw new Error(`oncall no sembrado para ${service}`);
  }
  return {
    service,
    rotation: oncall.rotation,
    primary: { name: oncall.primaryName, handle: oncall.primaryHandle },
    secondary: { name: oncall.secondaryName, handle: oncall.secondaryHandle },
    escalationMinutes: oncall.escalationMinutes,
    policy: oncall.policy,
  };
}

function searchRunbooksResult(query: string): unknown {
  const needle = query.toLowerCase();
  const runbooks = buildRunbooks(FIXTURE_SEED_ANCHOR_MS)
    .filter((runbook) =>
      `${runbook.title} ${runbook.bodyMd}`.toLowerCase().includes(needle),
    )
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, 5)
    .map((runbook) => ({
      service: runbook.slug ?? "global",
      slug: runbook.runbookSlug,
      title: runbook.title,
      bodyMd: runbook.bodyMd.slice(0, 2000),
      updatedAt: new Date(runbook.updatedAtMs).toISOString(),
    }));

  return { query, returned: runbooks.length, runbooks };
}

function proposeRollbackResult(
  service: string,
  toVersion: string,
): unknown {
  const deploys = buildDeploys(FIXTURE_SEED_ANCHOR_MS)
    .filter((deploy) => deploy.slug === service)
    .sort((left, right) => right.deployedAtMs - left.deployedAtMs);
  const current = deploys[0];
  const target = deploys.find((deploy) => deploy.version === toVersion);
  if (!target) {
    throw new Error(`unknown version for ${service}: ${toVersion}`);
  }
  const blastRadius = blastRadiusOf(service);
  const evidence = [
    `despliegue actual ${current?.version ?? "desconocido"} (${current?.commitSha ?? "?"}): ${
      current?.diffSummary ?? "sin resumen"
    }`,
    `version objetivo ${target.version} (${target.commitSha}): ${target.diffSummary}`,
    `el ultimo rollout quedo en ${current?.rolloutStatus ?? "desconocido"}`,
  ];
  if (blastRadius.dependency_count > 0) {
    evidence.push(
      `el cambio alcanza a ${blastRadius.dependents.length} servicio(s) dependiente(s): ${blastRadius.dependents.join(", ")}`,
    );
  }
  return {
    kind: "rollback",
    target: service,
    risk: "alto",
    summary: `rollback de ${service} de ${current?.version ?? "?"} a ${toVersion}`,
    diff: {
      kind: "rollback",
      service,
      from_version: current?.version ?? "",
      to_version: target.version,
      rollout_percent: 100,
      commit_sha: target.commitSha,
      files_changed: target.filesChanged,
    },
    blast_radius: blastRadius,
    evidence,
  };
}

function proposeSetFlagResult(
  flagKey: string,
  value: string | number | boolean,
): unknown {
  const { flags, changes } = buildFeatureFlags(FIXTURE_SEED_ANCHOR_MS);
  const flag = flags.find((candidate) => candidate.key === flagKey);
  if (!flag) {
    throw new Error(`unknown feature flag: ${flagKey}`);
  }
  const flagChanges = changes
    .filter((change) => change.flagKey === flagKey)
    .sort((left, right) => right.changedAtMs - left.changedAtMs)
    .slice(0, 3);
  const blastRadius = blastRadiusOf(flag.slug);
  const toValue = String(value);
  const evidence = [
    `flag ${flag.key} de ${flag.slug}: enabled=${flag.enabled} rollout=${flag.rolloutPercent}%`,
    `descripcion: ${flag.description}`,
    `ultimo cambio: ${flag.updatedBy} (${new Date(flag.updatedAtMs).toISOString()})`,
  ];
  for (const change of flagChanges) {
    evidence.push(
      `cambio anterior ${new Date(change.changedAtMs).toISOString()}: ${change.fromValue} -> ${change.toValue} (${change.reason})`,
    );
  }
  if (flag.rolloutPercent < 100) {
    evidence.push(
      `el rollout esta en ${flag.rolloutPercent}%: el cambio no afecta a todo el trafico`,
    );
  }
  return {
    kind: "set_flag",
    target: flag.key,
    risk: "alto",
    summary: `cambio de la flag ${flag.key} de ${String(flag.enabled)} a ${toValue}`,
    diff: {
      kind: "set_flag",
      flag: flag.key,
      service: flag.slug,
      from_value: String(flag.enabled),
      to_value: toValue,
      rollout_percent: flag.rolloutPercent,
    },
    blast_radius: blastRadius,
    evidence,
  };
}

function resultFor(tool: ToolName, args: Record<string, unknown>): unknown {
  switch (tool) {
    case "query_metrics":
      return queryMetricsResult(
        String(args.service),
        String(args.metric),
        String(args.window),
        String(args.step),
        String(args.agg),
      );
    case "search_logs":
      return searchLogsResult(
        String(args.service),
        String(args.query),
        String(args.window),
        typeof args.level === "string" ? args.level : null,
        Number(args.limit),
      );
    case "get_deploys":
      return {
        service: String(args.service),
        window: String(args.window),
        deploys: deploysFor(String(args.service), String(args.window)),
      };
    case "get_trace_summary":
      return traceSummaryResult(String(args.service), String(args.window));
    case "get_feature_flags":
      return featureFlagsResult(String(args.service));
    case "list_alerts":
      return listAlertsResult(
        typeof args.service === "string" ? args.service : null,
        typeof args.status === "string" ? args.status : null,
        String(args.window),
      );
    case "get_oncall":
      return oncallResult(String(args.service));
    case "search_runbooks":
      return searchRunbooksResult(String(args.query));
    case "propose_rollback":
      return proposeRollbackResult(String(args.service), String(args.to_version));
    case "propose_set_flag":
      return proposeSetFlagResult(
        String(args.flag),
        args.value as string | number | boolean,
      );
    case "list_services":
      return {
        services: seedServices().map((service) => ({
          slug: service.slug,
          displayName: service.displayName,
          role: service.role,
          tier: service.tier,
          ownerTeam: service.ownerTeam,
          dependsOn: [...service.dependsOn].sort(),
        })),
      };
    case "get_service": {
      const service = serviceOf(String(args.name));
      if (!service) {
        throw new Error(`unknown service: ${String(args.name)}`);
      }
      return {
        slug: service.slug,
        displayName: service.displayName,
        role: service.role,
        tier: service.tier,
        ownerTeam: service.ownerTeam,
        dependsOn: [...service.dependsOn].sort(),
        slo: {},
      };
    }
    case "propose_silence_alert":
      throw new Error("propose_silence_alert no se usa en el golden set");
  }
}

export function buildGoldenFixtures(): FixtureFile[] {
  const catalog = defaultCatalog();
  const fixtures: FixtureFile[] = [];

  for (const evalCase of goldenCases()) {
    const entries: FixtureEntry[] = [];
    for (const evalStep of evalCase.script) {
      const tool = resolveCapability(evalStep.capability, catalog);
      const args = ALL_TOOL_INPUT_SCHEMAS[tool].parse(evalStep.args) as Record<
        string,
        unknown
      >;
      try {
        entries.push({ tool, args, result: resultFor(tool, args), error: null });
      } catch (error) {
        entries.push({
          tool,
          args,
          result: null,
          error: {
            code: "internal",
            message: error instanceof Error ? error.message : "error desconocido",
          },
        });
      }
    }
    fixtures.push({
      version: 1,
      caseId: evalCase.id,
      fixture: "golden",
      recordedAt: new Date(FIXTURE_RECORDED_NOW_MS).toISOString(),
      entries,
    });
  }

  return fixtures;
}
