import { parseDurationSeconds } from "@beacon/core/domain/duration";
import type { GetDeploysInput } from "@beacon/core/schemas/tools";
import type { Pool } from "pg";

import { requireServiceId } from "./service-id.js";

export interface DeploySummary {
  version: string;
  commitSha: string;
  author: string;
  deployedAt: string;
  diffSummary: string;
  filesChanged: number;
  rolloutStatus: string;
}

interface DeployRow {
  version: string;
  commit_sha: string;
  author: string;
  deployed_at: Date;
  diff_summary: string;
  files_changed: number;
  rollout_status: string;
}

const GET_DEPLOYS_SQL = `
  select d.version,
         d.commit_sha,
         d.author,
         d.deployed_at,
         d.diff_summary,
         d.files_changed,
         d.rollout_status
  from deploys d
  where d.service_id = $1
    and d.deployed_at >= now() - make_interval(secs => $2)
    and d.deployed_at < now()
  order by d.deployed_at desc
`;

export async function getDeploys(
  pool: Pool,
  input: GetDeploysInput,
): Promise<{ service: string; window: string; deploys: DeploySummary[] }> {
  const serviceId = await requireServiceId(pool, input.service);
  const windowSeconds = parseDurationSeconds(input.window);

  const { rows } = await pool.query<DeployRow>(GET_DEPLOYS_SQL, [serviceId, windowSeconds]);

  return {
    service: input.service,
    window: input.window,
    deploys: rows.map((row) => ({
      version: row.version,
      commitSha: row.commit_sha,
      author: row.author,
      deployedAt: row.deployed_at.toISOString(),
      diffSummary: row.diff_summary,
      filesChanged: row.files_changed,
      rolloutStatus: row.rollout_status,
    })),
  };
}
