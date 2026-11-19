import type { Model, ModelContext, ModelDecision, Observation } from "@beacon/core/ports/model";
import type { FinalAnswer } from "@beacon/core/schemas/runs";
import type { ReadToolName } from "@beacon/core/schemas/tools";

export const MOCK_MODEL_ID = "mock";
export const MOCK_PROMPT_VERSION = "m2-v0";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function lastResult(observations: Observation[], tool: ReadToolName): unknown {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (observation?.tool === tool) {
      return observation.result;
    }
  }
  return undefined;
}

function metricSummary(observations: Observation[]): { max: number; points: number } | null {
  const result = asRecord(lastResult(observations, "query_metrics"));
  if (!Array.isArray(result?.points)) {
    return null;
  }
  const values = result.points
    .map((point) => asRecord(point)?.value)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? { max: Math.max(...values), points: values.length } : null;
}

function latestDeploy(observations: Observation[]): string | null {
  const result = asRecord(lastResult(observations, "get_deploys"));
  if (!Array.isArray(result?.deploys)) {
    return null;
  }
  const first = asRecord(result.deploys[0]);
  return typeof first?.version === "string" ? first.version : null;
}

function runbookCount(observations: Observation[]): number | null {
  const result = asRecord(lastResult(observations, "search_runbooks"));
  return Array.isArray(result?.runbooks) ? result.runbooks.length : null;
}

function finalAnswer(observations: Observation[]): FinalAnswer {
  const metrics = metricSummary(observations);
  const deploy = latestDeploy(observations);
  const runbooks = runbookCount(observations);

  const evidence: string[] = [];
  if (metrics) {
    evidence.push(
      `query_metrics checkout/http_5xx_rate: max=${metrics.max} en ${metrics.points} puntos`,
    );
  }
  if (deploy) {
    evidence.push(`get_deploys checkout: version mas reciente ${deploy}`);
  }
  if (runbooks !== null) {
    evidence.push(`search_runbooks "rollback": ${runbooks} coincidencias`);
  }
  if (evidence.length === 0) {
    evidence.push("las tools no devolvieron datos en las ventanas consultadas");
  }

  return {
    finding: metrics
      ? `checkout alcanza un maximo de ${metrics.max} en http_5xx_rate en la ventana consultada`
      : "checkout no devuelve puntos de http_5xx_rate en la ventana consultada",
    evidence,
    proposedAction: null,
    confidence: metrics ? 0.6 : 0.3,
    nextStep: runbooks ? "seguir el runbook de rollback de checkout" : null,
  };
}

/**
 * Modelo guionizado para M2. **No es un LLM**: no llama a ningún proveedor, no
 * gasta tokens y su secuencia es fija. Sirve para ejercitar el loop, la
 * persistencia y el gateway sin claves ni coste; el adaptador live llega con
 * presupuesto en un hito posterior.
 *
 * La respuesta final se construye con lo que devolvieron las tools: no inventa
 * cifras ni versiones.
 */
export class MockModel implements Model {
  readonly id = MOCK_MODEL_ID;
  readonly promptVersion = MOCK_PROMPT_VERSION;

  async decide(context: ModelContext): Promise<ModelDecision> {
    switch (context.turn) {
      case 0:
        return {
          type: "tool_call",
          tool: "query_metrics",
          args: {
            service: "checkout",
            metric: "http_5xx_rate",
            window: "2h",
            step: "5m",
            agg: "avg",
          },
          rationale: "medir el sintoma antes de buscar la causa",
        };
      case 1:
        return {
          type: "tool_call",
          tool: "get_deploys",
          args: { service: "checkout", window: "24h" },
          rationale: "correlacionar el pico con un despliegue reciente",
        };
      case 2:
        return {
          type: "tool_call",
          tool: "search_runbooks",
          args: { query: "rollback" },
          rationale: "buscar el procedimiento aprobado antes de proponer nada",
        };
      default:
        return { type: "final", answer: finalAnswer(context.observations) };
    }
  }
}