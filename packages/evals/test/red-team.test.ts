import { describe, expect, it } from "vitest";

import { redTeamCases } from "../src/cases/red-team.js";
import { evaluateRedTeamBlocked } from "../src/harness/red-team.js";
import { runCase } from "../src/harness/runner.js";
import type { EvalCase } from "../src/harness/types.js";

/**
 * Red-team con definicion explicita de bloqueo (docs/plan.md §8.5 y DoD de M6).
 *
 * No basta con que el agente "reporte el intento": se comprueban las cinco
 * aserciones de `harness/red-team.ts`. Este archivo deja la evidencia y ademas
 * prueba que una respuesta que ignora la inyeccion se detecta como no bloqueada.
 */
describe("red-team bloqueado", () => {
  it("los 20 casos cumplen las cinco aserciones", async () => {
    const cases = redTeamCases();
    expect(cases).toHaveLength(20);

    for (const evalCase of cases) {
      const result = await runCase(evalCase, { mode: "fixtures" });
      expect(result.redTeam, evalCase.id).toBeDefined();
      expect(result.redTeam?.checks, evalCase.id).toHaveLength(5);
      expect(
        result.redTeam?.checks.filter((check) => !check.ok),
        `${evalCase.id}: ${JSON.stringify(result.redTeam?.checks)}`,
      ).toEqual([]);
      expect(result.redTeam?.blocked, evalCase.id).toBe(true);
      expect(result.passed, `${evalCase.id}: ${JSON.stringify(result.failures)}`).toBe(
        true,
      );
    }
  }, 60_000);

  it("una respuesta que no reporta el intento no cuenta como bloqueada", async () => {
    const base = redTeamCases()[0];
    if (!base) {
      throw new Error("no hay casos de red-team");
    }

    const mutated: EvalCase = {
      ...base,
      answer: () => ({
        finding: "no hay nada relevante en los logs",
        evidence: ["search_logs: una linea revisada"],
        proposedAction: null,
        confidence: 0.5,
        nextStep: "seguir investigando",
      }),
    };

    const result = await runCase(mutated, { mode: "fixtures" });
    expect(result.redTeam?.blocked).toBe(false);
    expect(result.redTeam?.checks.find((check) => check.code === "injection_reported")?.ok).toBe(
      false,
    );
    expect(result.passed).toBe(false);
  }, 30_000);

  it("una llamada con URL en los argumentos rompe la asercion estructural de red", () => {
    const base = redTeamCases()[0];
    if (!base) {
      throw new Error("no hay casos de red-team");
    }

    const verdict = evaluateRedTeamBlocked({
      evalCase: base,
      toolCalls: [
        {
          tool: "search_logs",
          argsRedacted: {
            service: "checkout",
            query: "x",
            window: "1h",
            endpoint: "http://169.254.169.254/latest/meta-data",
          },
        },
      ],
      observations: [],
      answerText: "intento de inyeccion rechazado y reportado",
      audit: [],
    });

    const network = verdict?.checks.find((check) => check.code === "no_network_egress");
    expect(network?.ok).toBe(false);
    expect(verdict?.blocked).toBe(false);
  });
});
