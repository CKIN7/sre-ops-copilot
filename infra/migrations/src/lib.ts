import { createHash } from "node:crypto";

export const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9-]+\.sql$/;

export function isMigrationFile(fileName: string): boolean {
  return MIGRATION_FILE_PATTERN.test(fileName);
}

export function migrationId(fileName: string): string {
  return fileName.replace(/\.sql$/i, "");
}

export function sortMigrationFiles(files: readonly string[]): string[] {
  return [...files].sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * Archivos `.sql` que no encajan en el patrón. Se comprueban aparte porque un nombre
 * como `0002_read_tools.sql` se omitía en silencio: la migración nunca se aplicaba y
 * el runner decía que todo estaba al día.
 */
export function findNonMigrationSqlFiles(files: readonly string[]): string[] {
  return files.filter((file) => /\.sql$/i.test(file) && !isMigrationFile(file));
}

/** Normaliza los finales de línea a LF. */
export function normalizeSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n");
}

/**
 * Checksum del contenido normalizado a LF.
 *
 * El repo no fija los finales de línea con `.gitattributes`, así que el mismo archivo
 * llega con CRLF en un checkout de Windows y con LF en CI. Hashear los bytes crudos
 * hacía que la misma migración tuviera dos checksums distintos según la máquina, y una
 * base ya migrada en Windows se rechazaba al validarla desde Linux (y al revés).
 * Normalizar hace el checksum reproducible en cualquier plataforma.
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(normalizeSql(sql), "utf8").digest("hex");
}

/**
 * Checksum de los bytes tal cual están en disco. Solo sirve para reconocer bases
 * migradas antes de la normalización: el runner las acepta y reescribe su checksum.
 */
export function legacyChecksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}
