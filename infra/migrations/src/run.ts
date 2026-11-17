import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { isMigrationFile, migrationId, sortMigrationFiles } from "./lib.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LOCK_KEY = 827_346_192;

interface AppliedMigrationRow {
  id: string;
  checksum: string;
}

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const entries = await readdir(MIGRATIONS_DIR);
  const files = sortMigrationFiles(entries.filter(isMigrationFile));
  if (files.length === 0) {
    throw new Error(`no migration files found in ${MIGRATIONS_DIR}`);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "beacon-migrations",
  });
  await client.connect();

  try {
    await client.query("select pg_advisory_lock($1::bigint)", [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query<AppliedMigrationRow>(
      "select id, checksum from schema_migrations",
    );
    const applied = new Map(rows.map((row) => [row.id, row.checksum]));

    let appliedCount = 0;
    let skippedCount = 0;
    const startedAt = performance.now();

    for (const file of files) {
      const id = migrationId(file);
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = checksumOf(sql);
      const previous = applied.get(id);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`checksum mismatch for already applied migration ${id}`);
        }
        skippedCount += 1;
        console.log(`skip  ${id}`);
        continue;
      }

      const fileStartedAt = performance.now();
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (id, checksum) values ($1, $2)", [
          id,
          checksum,
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }

      appliedCount += 1;
      console.log(`apply ${id} (${(performance.now() - fileStartedAt).toFixed(0)} ms)`);
    }

    console.log(
      `migrations: ${appliedCount} aplicadas, ${skippedCount} omitidas en ${(
        performance.now() - startedAt
      ).toFixed(0)} ms`,
    );
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("migrations: fallo", error);
  process.exitCode = 1;
});
