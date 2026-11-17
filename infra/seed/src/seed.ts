import { METRIC_NAMES } from "@beacon/core/domain/metrics";
import { SERVICES } from "@beacon/core/domain/services";
import { Client } from "pg";

import {
  MINUTES_PER_DAY,
  SEED_DAYS,
  incidentWindowForAnchor,
  metricValueAt,
  pointsPerSeriesForScale,
  stepMinutesForScale,
} from "./generator.js";

const CHUNK_SIZE = 10_000;

const INSERT_METRICS_SQL = `
  insert into metrics_series (service_id, metric, ts, value)
  select * from unnest(
    $1::bigint[],
    $2::text[],
    $3::timestamptz[],
    $4::double precision[]
  )
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
    `seed: scale=${scale} step=${stepMinutes}m anchor=${new Date(anchorMs).toISOString()} ` +
      `points/serie=${pointsPerSeries} total esperado=${expectedPoints}`,
  );

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "beacon-seed",
  });
  await client.connect();

  try {
    const startedAt = performance.now();
    await client.query("truncate metrics_series, service_deps, services restart identity cascade");

    const serviceIds = new Map<string, string>();
    for (const service of SERVICES) {
      const { rows } = await client.query<{ id: string }>(
        `insert into services (slug, display_name, role, tier, owner_team)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [service.slug, service.displayName, service.role, service.tier, service.ownerTeam],
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
            timestamps[index] = new Date(epochMinute * 60_000).toISOString();
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
    console.log(
      `seed: total ${(performance.now() - startedAt).toFixed(0)} ms; ` +
        `incidente ${new Date(incident.startMs).toISOString()} -> ${new Date(
          incident.endMs,
        ).toISOString()} (${SERVICES.length}/${SERVICES.length} servicios)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("seed: fallo", error);
  process.exitCode = 1;
});
