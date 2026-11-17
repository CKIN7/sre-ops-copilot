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
