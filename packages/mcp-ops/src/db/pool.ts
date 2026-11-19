import { Pool } from "pg";

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
  console.error(`[beacon-mcp-ops] error en el pool de Postgres: ${error.message}`);
}

export function createPool(
  connectionString: string,
  onError: (error: Error) => void = logPoolError,
): Pool {
  const pool = new Pool({
    connectionString,
    max: 4,
    application_name: "beacon-mcp-ops",
  });
  guardPoolErrors(pool, onError);
  return pool;
}