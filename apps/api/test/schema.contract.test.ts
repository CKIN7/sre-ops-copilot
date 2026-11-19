import { getTableColumns } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  runs,
  steps,
  tenants,
  toolCalls,
  users,
} from "../src/adapters/schema.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

const CONTROL_PLANE_TABLES = [
  ["tenants", tenants],
  ["users", users],
  ["agents", agents],
  ["runs", runs],
  ["steps", steps],
  ["tool_calls", toolCalls],
] as const;

/**
 * Contrato esquema↔Drizzle (ADR-009): el SQL versionado sigue siendo la fuente
 * de verdad, pero si una migración añade o renombra una columna, este test falla
 * hasta que el adaptador la modele.
 */
describeIntegration("contrato de esquema Drizzle", () => {
  let pool: Pool;

  beforeAll(() => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it("modela todas las columnas del control plane", async () => {
    for (const [tableName, table] of CONTROL_PLANE_TABLES) {
      const { rows } = await pool.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [tableName],
      );

      const databaseColumns = rows.map((row) => row.column_name).sort();
      const drizzleColumns = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();

      expect(drizzleColumns, tableName).toEqual(databaseColumns);
    }
  });
});