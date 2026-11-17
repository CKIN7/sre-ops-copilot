import { describe, expect, it } from "vitest";

import { parseDurationSeconds } from "../src/domain/duration.js";

describe("parseDurationSeconds", () => {
  it("convierte minutos y horas", () => {
    expect(parseDurationSeconds("90m")).toBe(5400);
    expect(parseDurationSeconds("6h")).toBe(21600);
    expect(parseDurationSeconds("45s")).toBe(45);
  });

  it("rechaza duraciones sin unidad o con cero", () => {
    expect(() => parseDurationSeconds("30")).toThrow("invalid duration");
    expect(() => parseDurationSeconds("0m")).toThrow("invalid duration");
    expect(() => parseDurationSeconds("1d")).toThrow("invalid duration");
  });
});
