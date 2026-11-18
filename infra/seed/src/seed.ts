import { METRIC_NAMES } from "@beacon/core/domain/metrics";
import { SERVICES } from "@beacon/core/domain/services";
import { Client } from "pg";

import {
  ALERT_COUNT,
  LOG_LINE_COUNT,
  MINUTES_PER_DAY,
  PROMPT_INJECTION_LINES,
  SEED_DAYS,
  SERVICE_SLOS,
  buildAlerts,
  buildDeploys,
  buildFeatureFlags,
  buildOncall,
  buildPromptInjectionLogs,
  buildRunbooks,
  incidentWindowForAnchor,
  logLineAt,
  metricValueAt,
  pointsPerSeriesForScale,
  stepMinutesForScale,
} from "./generator.js";

const CHUNK_SIZE = 10_000;
const NORMAL_LOG_COUNT = LOG_LINE_COUNT - PROMPT_INJECTION_LINES.length;

const INSERT_METRICS_SQL = `
  insert into metrics_series (service_id, metric, ts, value)
  select * from unnest(
    $1::bigint[],
    $2::text[],
    $3::timestamptz[],
    $4::double precision[]
  )
`;

const INSERT_LOGS_SQL = `
  insert into logs (service_id, ts, level, message, fields)
  select service_id, ts, level, message, fields::jsonb
  from unnest(
    $1::bigint[],
    $2::timestamptz[],
    $3::text[],
    $4::text[],
    $5::text[]
  ) as t(service_id, ts, level, message, fields)
`;

function floorToMinute(epochMs: number): number {
  return Math.floor(epochMs / 60_000) * 60_000;
}

function parseAnchor(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return floorToMinute(Date.now());
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`SEED_ANCHOR_ISO is not a valid ISO date: ${trimmed}`);
  }
  return floorToMinute(parsed);
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const scale = Number(process.env.SEED_SCALE ?? "1");
  const stepMinutes = stepMinutesForScale(scale);
  const pointsPerSeries = pointsPerSeriesForScale(scale);
  const anchorMs = parseAnchor(process.env.SEED_ANCHOR_ISO);
  const incident = incidentWindowForAnchor(anchorMs);
  const startMinute = Math.floor((anchorMs - SEED_DAYS * MINUTES_PER_DAY * 60_000) / 60_000);
  const expectedPoints = pointsPerSeries * SERVICES.length * METRIC_NAMES.length;

  console.log(
    `seed: scale=${scale} step=${stepMinutes}m anchor=${iso(anchorMs)} ` +
      `points/serie=${pointsPerSeries} total esperado=${expectedPoints}`,
  );

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "beacon-seed",
  });
  await client.connect();

  try {
    const startedAt = performance.now();
    await client.query(`
      truncate logs, deploys, alerts, feature_flag_changes, feature_flags, runbooks, oncall,
               metrics_series, service_deps, services
      restart identity cascade
    `);

    const serviceIds = new Map<string, string>();
    for (const service of SERVICES) {
      const { rows } = await client.query<{ id: string }>(
        `insert into services (slug, display_name, role, tier, owner_team, slo)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         returning id`,
        [
          service.slug,
          service.displayName,
          service.role,
          service.tier,
          service.ownerTeam,
          JSON.stringify(SERVICE_SLOS[service.slug]),
        ],
      );
      const id = rows[0]?.id;
      if (!id) {
        throw new Error(`no id returned for service ${service.slug}`);
      }
      serviceIds.set(service.slug, id);
    }

    for (const service of SERVICES) {
      const serviceId = serviceIds.get(service.slug);
      if (!serviceId) {
        throw new Error(`missing id for service ${service.slug}`);
      }
      for (const dependency of service.dependsOn) {
        await client.query(
          "insert into service_deps (service_id, depends_on_slug) values ($1, $2)",
          [serviceId, dependency],
        );
      }
    }
    console.log(
      `seed: inventario insertado (${SERVICES.length} servicios, ${SERVICES.reduce(
        (total, service) => total + service.dependsOn.length,
        0,
      )} dependencias) en ${(performance.now() - startedAt).toFixed(0)} ms`,
    );

    const metricsStartedAt = performance.now();
    let inserted = 0;

    for (const [serviceIndex, service] of SERVICES.entries()) {
      const serviceId = serviceIds.get(service.slug);
      if (!serviceId) {
        throw new Error(`missing id for service ${service.slug}`);
      }

      for (const metric of METRIC_NAMES) {
        let offset = 0;
        while (offset < pointsPerSeries) {
          const count = Math.min(CHUNK_SIZE, pointsPerSeries - offset);
          const ids = new Array<string>(count).fill(serviceId);
          const metrics = new Array<string>(count).fill(metric);
          const timestamps = new Array<string>(count);
          const values = new Array<number>(count);

          for (let index = 0; index < count; index += 1) {
            const epochMinute = startMinute + (offset + index) * stepMinutes;
            timestamps[index] = iso(epochMinute * 60_000);
            values[index] = metricValueAt(service.slug, metric, epochMinute, incident);
          }

          await client.query(INSERT_METRICS_SQL, [ids, metrics, timestamps, values]);
          inserted += count;
          offset += count;
        }
      }

      console.log(
        `seed: ${serviceIndex + 1}/${SERVICES.length} servicios (${service.slug}) ` +
          `${inserted} puntos en ${(performance.now() - metricsStartedAt).toFixed(0)} ms`,
      );
    }

    const metricsElapsed = performance.now() - metricsStartedAt;
    const { rows: countRows } = await client.query<{ points: string }>(
      "select count(*)::text as points from metrics_series",
    );
    const stored = Number(countRows[0]?.points ?? "0");

    if (stored !== expectedPoints) {
      throw new Error(`expected ${expectedPoints} metric points, found ${stored}`);
    }

    console.log(
      `seed: metricas insertadas ${inserted} (verificadas ${stored}) en ${metricsElapsed.toFixed(
        0,
      )} ms -> ${Math.round(inserted / (metricsElapsed / 1000))} puntos/s`,
    );

    // --- Logs -----------------------------------------------------------------
    const logsStartedAt = performance.now();
    let logsInserted = 0;

    for (let offset = 0; offset < NORMAL_LOG_COUNT; offset += CHUNK_SIZE) {
      const count = Math.min(CHUNK_SIZE, NORMAL_LOG_COUNT - offset);
      const ids = new Array<string>(count);
      const timestamps = new Array<string>(count);
      const levels = new Array<string>(count);
      const messages = new Array<string>(count);
      const fields = new Array<string>(count);

      for (let index = 0; index < count; index += 1) {
        const line = logLineAt(offset + index, anchorMs);
        const serviceId = serviceIds.get(line.slug);
        if (!serviceId) {
          throw new Error(`missing id for service ${line.slug}`);
        }
        ids[index] = serviceId;
        timestamps[index] = iso(line.tsMs);
        levels[index] = line.level;
        messages[index] = line.message;
        fields[index] = JSON.stringify(line.fields);
      }

      await client.query(INSERT_LOGS_SQL, [ids, timestamps, levels, messages, fields]);
      logsInserted += count;
    }

    const injections = buildPromptInjectionLogs(anchorMs);
    await client.query(INSERT_LOGS_SQL, [
      injections.map((line) => serviceIds.get(line.slug)),
      injections.map((line) => iso(line.tsMs)),
      injections.map((line) => line.level),
      injections.map((line) => line.message),
      injections.map((line) => JSON.stringify(line.fields)),
    ]);
    logsInserted += injections.length;

    if (logsInserted !== LOG_LINE_COUNT) {
      throw new Error(`expected ${LOG_LINE_COUNT} log lines, inserted ${logsInserted}`);
    }

    console.log(
      `seed: logs insertados ${logsInserted} en ${(performance.now() - logsStartedAt).toFixed(
        0,
      )} ms`,
    );

    // --- Deploys --------------------------------------------------------------
    const deploysStartedAt = performance.now();
    const deploys = buildDeploys(anchorMs);
    await client.query(
      `insert into deploys (service_id, version, commit_sha, author, deployed_at,
                            diff_summary, files_changed, rollout_status)
       select service_id, version, commit_sha, author, deployed_at,
              diff_summary, files_changed, rollout_status
       from unnest(
         $1::bigint[], $2::text[], $3::text[], $4::text[], $5::timestamptz[],
         $6::text[], $7::integer[], $8::text[]
       ) as t(service_id, version, commit_sha, author, deployed_at,
              diff_summary, files_changed, rollout_status)`,
      [
        deploys.map((deploy) => serviceIds.get(deploy.slug)),
        deploys.map((deploy) => deploy.version),
        deploys.map((deploy) => deploy.commitSha),
        deploys.map((deploy) => deploy.author),
        deploys.map((deploy) => iso(deploy.deployedAtMs)),
        deploys.map((deploy) => deploy.diffSummary),
        deploys.map((deploy) => deploy.filesChanged),
        deploys.map((deploy) => deploy.rolloutStatus),
      ],
    );
    console.log(
      `seed: ${deploys.length} deploys en ${(performance.now() - deploysStartedAt).toFixed(0)} ms`,
    );

    // --- Alertas --------------------------------------------------------------
    const alertsStartedAt = performance.now();
    const alerts = buildAlerts(anchorMs);
    await client.query(
      `insert into alerts (service_id, name, severity, status, started_at, resolved_at, summary)
       select service_id, name, severity, status, started_at, resolved_at, summary
       from unnest(
         $1::bigint[], $2::text[], $3::text[], $4::text[],
         $5::timestamptz[], $6::timestamptz[], $7::text[]
       ) as t(service_id, name, severity, status, started_at, resolved_at, summary)`,
      [
        alerts.map((alert) => serviceIds.get(alert.slug)),
        alerts.map((alert) => alert.name),
        alerts.map((alert) => alert.severity),
        alerts.map((alert) => alert.status),
        alerts.map((alert) => iso(alert.startedAtMs)),
        alerts.map((alert) => (alert.resolvedAtMs === null ? null : iso(alert.resolvedAtMs))),
        alerts.map((alert) => alert.summary),
      ],
    );
    console.log(
      `seed: ${alerts.length} alertas en ${(performance.now() - alertsStartedAt).toFixed(0)} ms`,
    );

    // --- Feature flags y su historial ----------------------------------------
    const flagsStartedAt = performance.now();
    const { flags, changes } = buildFeatureFlags(anchorMs);
    const { rows: flagRows } = await client.query<{ id: string; key: string }>(
      `insert into feature_flags (service_id, key, description, enabled, rollout_percent,
                                  updated_at, updated_by)
       select service_id, key, description, enabled, rollout_percent, updated_at, updated_by
       from unnest(
         $1::bigint[], $2::text[], $3::text[], $4::boolean[],
         $5::integer[], $6::timestamptz[], $7::text[]
       ) as t(service_id, key, description, enabled, rollout_percent, updated_at, updated_by)
       returning id, key`,
      [
        flags.map((flag) => serviceIds.get(flag.slug)),
        flags.map((flag) => flag.key),
        flags.map((flag) => flag.description),
        flags.map((flag) => flag.enabled),
        flags.map((flag) => flag.rolloutPercent),
        flags.map((flag) => iso(flag.updatedAtMs)),
        flags.map((flag) => flag.updatedBy),
      ],
    );

    const flagIds = new Map(flagRows.map((row) => [row.key, row.id]));
    await client.query(
      `insert into feature_flag_changes (flag_id, changed_at, changed_by, from_value, to_value, reason)
       select flag_id, changed_at, changed_by, from_value, to_value, reason
       from unnest(
         $1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[]
       ) as t(flag_id, changed_at, changed_by, from_value, to_value, reason)`,
      [
        changes.map((change) => flagIds.get(change.flagKey)),
        changes.map((change) => iso(change.changedAtMs)),
        changes.map((change) => change.changedBy),
        changes.map((change) => change.fromValue),
        changes.map((change) => change.toValue),
        changes.map((change) => change.reason),
      ],
    );
    console.log(
      `seed: ${flags.length} flags y ${changes.length} cambios en ` +
        `${(performance.now() - flagsStartedAt).toFixed(0)} ms`,
    );

    // --- Runbooks y oncall ----------------------------------------------------
    const docsStartedAt = performance.now();
    const runbooks = buildRunbooks(anchorMs);
    await client.query(
      `insert into runbooks (service_id, slug, title, body_md, updated_at)
       select service_id, slug, title, body_md, updated_at
       from unnest(
         $1::bigint[], $2::text[], $3::text[], $4::text[], $5::timestamptz[]
       ) as t(service_id, slug, title, body_md, updated_at)`,
      [
        runbooks.map((runbook) => (runbook.slug === null ? null : serviceIds.get(runbook.slug))),
        runbooks.map((runbook) => runbook.runbookSlug),
        runbooks.map((runbook) => runbook.title),
        runbooks.map((runbook) => runbook.bodyMd),
        runbooks.map((runbook) => iso(runbook.updatedAtMs)),
      ],
    );

    const oncall = buildOncall();
    // `pg` no sabe serializar arrays de arrays: un `integer[][]` en `unnest` llega como
    // `integer`. Se insertan las seis filas una a una, que además deja el SQL legible.
    for (const row of oncall) {
      await client.query(
        `insert into oncall (service_id, rotation, primary_name, primary_handle,
                             secondary_name, secondary_handle, escalation_minutes, policy)
         values ($1, $2, $3, $4, $5, $6, $7::integer[], $8)`,
        [
          serviceIds.get(row.slug),
          row.rotation,
          row.primaryName,
          row.primaryHandle,
          row.secondaryName,
          row.secondaryHandle,
          row.escalationMinutes,
          row.policy,
        ],
      );
    }
    console.log(
      `seed: ${runbooks.length} runbooks y ${oncall.length} guardias en ` +
        `${(performance.now() - docsStartedAt).toFixed(0)} ms`,
    );

    // --- Verificación final ---------------------------------------------------
    const { rows: verification } = await client.query<{
      logs: string;
      deploys: string;
      alerts: string;
      flags: string;
      runbooks: string;
      oncall: string;
    }>(`
      select (select count(*) from logs)::text as logs,
             (select count(*) from deploys)::text as deploys,
             (select count(*) from alerts)::text as alerts,
             (select count(*) from feature_flags)::text as flags,
             (select count(*) from runbooks)::text as runbooks,
             (select count(*) from oncall)::text as oncall
    `);
    const final = verification[0];

    if (!final) {
      throw new Error("verification query returned no rows");
    }

    const expected: Record<string, number> = {
      logs: LOG_LINE_COUNT,
      deploys: deploys.length,
      alerts: ALERT_COUNT,
      flags: flags.length,
      runbooks: runbooks.length,
      oncall: oncall.length,
    };

    for (const [table, expectedCount] of Object.entries(expected)) {
      const actual = Number(final[table as keyof typeof final]);
      if (actual !== expectedCount) {
        throw new Error(`expected ${expectedCount} rows in ${table}, found ${actual}`);
      }
    }

    console.log(
      `seed: verificadas ${final.logs} lineas de log, ${final.deploys} deploys, ` +
        `${final.alerts} alertas, ${final.flags} flags, ${final.runbooks} runbooks y ` +
        `${final.oncall} guardias`,
    );
    console.log(
      `seed: total ${(performance.now() - startedAt).toFixed(0)} ms; ` +
        `incidente ${iso(incident.startMs)} -> ${iso(incident.endMs)}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("seed: fallo", error);
  process.exitCode = 1;
});
