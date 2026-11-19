import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type Database = NodePgDatabase<Record<string, never>>;

export interface DbHandle {
  db: Database;
  close: () => Promise<void>;
}

/** Pool único del proceso; el composition root es el único que lo crea y lo cierra. */
export function createDb(databaseUrl: string): DbHandle {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "beacon-api",
  });

  return {
    db: drizzle(pool),
    close: () => pool.end(),
  };
}