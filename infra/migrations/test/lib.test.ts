import { describe, expect, it } from "vitest";

import { isMigrationFile, migrationId, sortMigrationFiles } from "../src/lib.js";

describe("descubrimiento de migraciones", () => {
  it("acepta el formato NNNN-slug.sql y rechaza el resto", () => {
    expect(isMigrationFile("0001_domain.sql")).toBe(true);
    expect(isMigrationFile("0002_logs.sql")).toBe(true);
    expect(isMigrationFile("1_domain.sql")).toBe(false);
    expect(isMigrationFile("0001-domain.sql")).toBe(false);
    expect(isMigrationFile("0001_domain.txt")).toBe(false);
  });

  it("deriva el id sin extension", () => {
    expect(migrationId("0001_domain.sql")).toBe("0001_domain");
  });

  it("ordena numericamente por prefijo", () => {
    expect(sortMigrationFiles(["0010_b.sql", "0002_a.sql", "0001_c.sql"])).toEqual([
      "0001_c.sql",
      "0002_a.sql",
      "0010_b.sql",
    ]);
  });
});
