import { describe, expect, it } from "vitest";

import { createRunInputSchema, finalAnswerSchema, runIdSchema } from "../src/schemas/runs.js";

describe("createRunInputSchema", () => {
  it("normaliza el goal con trim", () => {
    expect(createRunInputSchema.parse({ goal: "  investiga checkout  " }).goal).toBe(
      "investiga checkout",
    );
  });

  it("rechaza goals vacios o gigantes", () => {
    expect(createRunInputSchema.safeParse({ goal: "   " }).success).toBe(false);
    expect(createRunInputSchema.safeParse({ goal: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("finalAnswerSchema", () => {
  it("exige evidencia y confianza acotada", () => {
    const answer = {
      finding: "checkout sube 5xx",
      evidence: ["query_metrics: pico 4.1%"],
      proposedAction: null,
      confidence: 0.8,
      nextStep: null,
    };
    expect(finalAnswerSchema.parse(answer)).toEqual(answer);
    expect(finalAnswerSchema.safeParse({ ...answer, evidence: [] }).success).toBe(false);
    expect(finalAnswerSchema.safeParse({ ...answer, confidence: 1.2 }).success).toBe(false);
  });
});

describe("runIdSchema", () => {
  it("acepta UUID y rechaza texto libre", () => {
    expect(runIdSchema.safeParse("00000000-0000-4000-8000-000000000000").success).toBe(true);
    expect(runIdSchema.safeParse("run-1").success).toBe(false);
  });
});
