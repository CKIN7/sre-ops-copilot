import { describe, expect, it } from "vitest";

import {
  checksumOf,
  findNonMigrationSqlFiles,
  isMigrationFile,
  legacyChecksumOf,
  migrationId,
  normalizeSql,
  sortMigrationFiles,
} from "../src/lib.js";

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

  it("detecta los .sql que no siguen el convenio en vez de omitirlos", () => {
    expect(
      findNonMigrationSqlFiles([
        "0001_domain.sql",
        "0002_read-tools.sql",
        "0003_read_tools.sql",
        "README.md",
      ]),
    ).toEqual(["0003_read_tools.sql"]);
  });
});

describe("checksum de migraciones", () => {
  it("normaliza los finales de linea a LF", () => {
    expect(normalizeSql("a;\r\nb;\r\n")).toBe("a;\nb;\n");
    expect(normalizeSql("a;\nb;\n")).toBe("a;\nb;\n");
  });

  it("da el mismo checksum con CRLF que con LF", () => {
    const lf = "create table t (id int);\ncreate index i on t (id);\n";
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(checksumOf(crlf)).toBe(checksumOf(lf));
  });

  it("el checksum legacy si distingue los bytes crudos", () => {
    const lf = "select 1;\n";
    const crlf = "select 1;\r\n";

    expect(legacyChecksumOf(crlf)).not.toBe(legacyChecksumOf(lf));
    expect(legacyChecksumOf(lf)).toBe(checksumOf(lf));
  });

  it("cambia si cambia el SQL", () => {
    expect(checksumOf("select 1;\n")).not.toBe(checksumOf("select 2;\n"));
  });
});
