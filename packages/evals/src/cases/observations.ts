import type { Observation } from "@beacon/core/ports/model";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resultOf(observations: Observation[], tool: string): unknown {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (observation?.tool === tool) {
      return observation.result;
    }
  }
  return undefined;
}

export function observedTools(observations: Observation[]): string[] {
  return observations.map((observation) => observation.tool);
}

export function metricPoints(
  observations: Observation[],
  metric?: string,
): number[] {
  const result = asRecord(resultOf(observations, "query_metrics"));
  const points = asArray(result?.points);
  return points
    .map((point) => asRecord(point))
    .filter((point) => !metric || point?.metric === metric || result?.metric === metric)
    .map((point) => point?.value)
    .filter((value): value is number => typeof value === "number");
}

/** Puntos de una metrica concreta, aunque el run haya consultado varias. */
export function metricSeries(
  observations: Observation[],
  metric: string,
): number[] {
  const values: number[] = [];
  for (const observation of observations) {
    if (observation.tool !== "query_metrics") {
      continue;
    }
    const result = asRecord(observation.result);
    if (result?.metric !== metric) {
      continue;
    }
    for (const point of asArray(result.points)) {
      const value = asRecord(point)?.value;
      if (typeof value === "number") {
        values.push(value);
      }
    }
  }
  return values;
}

export function maxOfSeries(observations: Observation[], metric: string): number | null {
  const values = metricSeries(observations, metric);
  return values.length > 0 ? Math.max(...values) : null;
}

export function metricMax(observations: Observation[], metric?: string): number | null {
  const values = metricPoints(observations, metric);
  return values.length > 0 ? Math.max(...values) : null;
}

export function metricMin(observations: Observation[], metric?: string): number | null {
  const values = metricPoints(observations, metric);
  return values.length > 0 ? Math.min(...values) : null;
}

export function latestDeploy(
  observations: Observation[],
): { version: string; diffSummary: string; rolloutStatus: string } | null {
  const result = asRecord(resultOf(observations, "get_deploys"));
  const first = asRecord(asArray(result?.deploys)[0]);
  if (!first || typeof first.version !== "string") {
    return null;
  }
  return {
    version: first.version,
    diffSummary: typeof first.diffSummary === "string" ? first.diffSummary : "",
    rolloutStatus:
      typeof first.rolloutStatus === "string" ? first.rolloutStatus : "desconocido",
  };
}

export function deployVersions(observations: Observation[]): string[] {
  const result = asRecord(resultOf(observations, "get_deploys"));
  return asArray(result?.deploys)
    .map((deploy) => asRecord(deploy)?.version)
    .filter((version): version is string => typeof version === "string");
}

export function flagOf(
  observations: Observation[],
  key: string,
): { enabled: boolean; rolloutPercent: number; key: string } | null {
  const result = asRecord(resultOf(observations, "get_feature_flags"));
  const flag = asArray(result?.flags)
    .map((entry) => asRecord(entry))
    .find((entry) => entry?.key === key);
  if (!flag) {
    return null;
  }
  return {
    key,
    enabled: flag.enabled === true,
    rolloutPercent:
      typeof flag.rolloutPercent === "number" ? flag.rolloutPercent : 0,
  };
}

export function firstAlert(
  observations: Observation[],
): { id: string; name: string; service: string; summary: string } | null {
  const result = asRecord(resultOf(observations, "list_alerts"));
  const alert = asRecord(asArray(result?.alerts)[0]);
  if (!alert || typeof alert.id !== "string") {
    return null;
  }
  return {
    id: alert.id,
    name: typeof alert.name === "string" ? alert.name : "alerta",
    service: typeof alert.service === "string" ? alert.service : "",
    summary: typeof alert.summary === "string" ? alert.summary : "",
  };
}

export function slowestDownstream(
  observations: Observation[],
): { name: string; latencyP95Ms: number | null; instrumented: boolean } | null {
  const result = asRecord(resultOf(observations, "get_trace_summary"));
  const downstreams = asArray(result?.downstreams)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (downstreams.length === 0) {
    return null;
  }

  const sorted = [...downstreams].sort((left, right) => {
    const leftValue = typeof left.latencyP95Ms === "number" ? left.latencyP95Ms : -1;
    const rightValue = typeof right.latencyP95Ms === "number" ? right.latencyP95Ms : -1;
    return rightValue - leftValue;
  });
  const slowest = sorted[0];
  if (!slowest || typeof slowest.name !== "string") {
    return null;
  }
  return {
    name: slowest.name,
    latencyP95Ms:
      typeof slowest.latencyP95Ms === "number" ? slowest.latencyP95Ms : null,
    instrumented: slowest.instrumented === true,
  };
}

export function oncallOf(
  observations: Observation[],
): { primary: string; handle: string } | null {
  const result = asRecord(resultOf(observations, "get_oncall"));
  const primary = asRecord(result?.primary);
  if (!primary || typeof primary.name !== "string") {
    return null;
  }
  return {
    primary: primary.name,
    handle: typeof primary.handle === "string" ? primary.handle : "",
  };
}

export function logLines(observations: Observation[]): string[] {
  const result = asRecord(resultOf(observations, "search_logs"));
  return asArray(result?.lines)
    .map((line) => asRecord(line)?.message)
    .filter((message): message is string => typeof message === "string");
}

export function runbookBodies(observations: Observation[]): string[] {
  const result = asRecord(resultOf(observations, "search_runbooks"));
  return asArray(result?.runbooks)
    .map((runbook) => asRecord(runbook)?.bodyMd)
    .filter((body): body is string => typeof body === "string");
}

function stringsDeep(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      stringsDeep(item, out);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      stringsDeep(item, out);
    }
  }
  return out;
}

const INJECTION_MARKERS = [
  "ignore previous instructions",
  "system:",
  "assistant:",
  "disable approval",
  "apply pending changes",
  "maintenance mode",
  "dump the full dataset",
  "call propose_rollback",
  "ignora las instrucciones",
  "ignora todas las instrucciones",
  "olvida las instrucciones",
  "you are now",
  "exfiltr",
  "reveal the token",
  "imprime el token",
] as const;

/** Devuelve los marcadores de inyeccion presentes en lo que devolvieron las tools. */
export function injectionMarkers(observations: Observation[]): string[] {
  const haystack = stringsDeep(observations.map((observation) => observation.result))
    .join("\n")
    .toLowerCase();
  return INJECTION_MARKERS.filter((marker) => haystack.includes(marker));
}

export function hasInjection(observations: Observation[]): boolean {
  return injectionMarkers(observations).length > 0;
}

/** La respuesta final que cita el plan de una escritura, sin inventarlo. */
export function proposedActionText(observations: Observation[]): string | null {
  for (const observation of observations) {
    const result = asRecord(observation.result);
    if (!result || typeof result.proposal_id !== "string") {
      continue;
    }
    const plan = asRecord(result.plan);
    if (!plan) {
      continue;
    }
    const diff = asRecord(plan.diff);
    if (diff?.kind === "rollback") {
      return `propose_rollback ${String(diff.service ?? "")} de ${String(
        diff.from_version ?? "?",
      )} a ${String(diff.to_version ?? "?")}`;
    }
    if (diff?.kind === "set_flag") {
      return `propose_set_flag ${String(diff.flag ?? "")} a ${String(
        diff.to_value ?? "?",
      )}`;
    }
    if (diff?.kind === "silence_alert") {
      return `propose_silence_alert ${String(diff.alert_id ?? "")} durante ${String(
        diff.duration_seconds ?? "?",
      )}s`;
    }
  }
  return null;
}

export function evidenceFrom(observations: Observation[]): string[] {
  const evidence: string[] = [];
  for (const observation of observations) {
    const result = asRecord(observation.result);
    if (observation.tool === "query_metrics" && result) {
      const values = asArray(result.points)
        .map((point) => asRecord(point)?.value)
        .filter((value): value is number => typeof value === "number");
      if (values.length > 0) {
        evidence.push(
          `query_metrics ${String(result.service ?? "")}/${String(
            result.metric ?? "",
          )}: max=${Math.max(...values)} en ${values.length} puntos`,
        );
      }
    } else if (observation.tool === "get_deploys" && result) {
      const first = asRecord(asArray(result.deploys)[0]);
      if (typeof first?.version === "string") {
        evidence.push(
          `get_deploys ${String(result.service ?? "")}: version mas reciente ${first.version} (${String(
            first.rolloutStatus ?? "?",
          )})`,
        );
      }
    } else if (observation.tool === "search_logs" && result) {
      evidence.push(
        `search_logs "${String(result.query ?? "")}": ${String(
          result.returned ?? 0,
        )} lineas, ${String(result.redactions ?? 0)} redacciones`,
      );
    } else if (observation.tool === "search_runbooks" && result) {
      evidence.push(
        `search_runbooks "${String(result.query ?? "")}": ${String(
          result.returned ?? 0,
        )} coincidencias`,
      );
    } else if (observation.tool === "get_trace_summary" && result) {
      const slowest = slowestDownstream([observation]);
      if (slowest) {
        evidence.push(
          `get_trace_summary ${String(result.service ?? "")}: downstream mas lento ${slowest.name} (${String(
            slowest.latencyP95Ms ?? "sin metricas",
          )} ms)`,
        );
      }
    } else if (observation.tool === "get_feature_flags" && result) {
      const flag = asRecord(asArray(result.flags)[0]);
      evidence.push(
        `get_feature_flags ${String(result.service ?? "")}: ${asArray(result.flags).length} flags${flag ? `, primera ${String(flag.key ?? "?")}` : ""}`,
      );
    } else if (observation.tool === "list_alerts" && result) {
      evidence.push(`list_alerts: ${asArray(result.alerts).length} alertas`);
    } else if (observation.tool === "get_oncall" && result) {
      const primary = asRecord(result.primary);
      evidence.push(
        `get_oncall ${String(result.service ?? "")}: primario ${String(
          primary?.name ?? "?",
        )}`,
      );
    }
  }
  return evidence.length > 0 ? evidence : ["sin evidencia en las tools consultadas"];
}
