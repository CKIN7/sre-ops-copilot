import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type Database = NodePgDatabase<Record<string, never>>;

export interface DbHandle {
  db: Database;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  /** Se invoca cuando un client idle pierde la conexión con Postgres. */
  onError?: (error: Error) => void;
}

/**
 * `pg` emite `error` en el pool cuando un client idle se cae (por ejemplo, al
 * reiniciar Postgres). Sin listener, Node lo trata como excepción no capturada y
 * tumba el proceso; con listener, el pool descarta esa conexión y abre otra en la
 * siguiente query.
 */
export function guardPoolErrors(
  pool: Pick<Pool, "on">,
  onError: (error: Error) => void,
): void {
  pool.on("error", onError);
}

function logPoolError(error: Error): void {
  console.error(`[beacon-api] error en el pool de Postgres: ${error.message}`);
}

/** Pool único del proceso; el composition root es el único que lo crea y lo cierra. */
export function createDb(
  databaseUrl: string,
  options: CreateDbOptions = {},
): DbHandle {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "beacon-api",
  });
  guardPoolErrors(pool, options.onError ?? logPoolError);

  return {
    db: drizzle(pool),
    close: () => pool.end(),
  };
}