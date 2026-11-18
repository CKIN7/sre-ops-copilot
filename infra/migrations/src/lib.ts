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
