import { AppError } from "@beacon/core/errors/app-error";
import type { Pool } from "pg";

/** Resuelve el id interno del servicio o falla con 404 de dominio. */
export async function requireServiceId(pool: Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "select id from services where slug = $1",
    [slug],
  );
  const row = rows[0];

  if (!row) {
    throw new AppError("not_found", `unknown service: ${slug}`, { statusCode: 404 });
  }

  return row.id;
}
