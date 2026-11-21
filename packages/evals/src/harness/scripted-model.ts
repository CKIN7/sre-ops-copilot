import type { Model, ModelContext, ModelDecision } from "@beacon/core/ports/model";
import type { ReadToolName } from "@beacon/core/schemas/tools";

import { resolveCapability, type ToolCatalog } from "./catalog.js";
import type { EvalCase } from "./types.js";

/**
 * Modelo guionizado por caso.
 *
 * El `MockModel` de M2 hace siempre la misma secuencia. Para evals hace falta que
 * cada caso tenga **su** trayectoria, asi que este modelo recibe el guion del caso y
 * resuelve cada paso contra el catalogo de tools. No es un LLM: no hay tokens ni
 * coste. Lo que si reproduce es la parte que importa para el harness: elegir una
 * tool a partir de su descripcion. Por eso el meta-eval puede degradar una
 * descripcion y observar el fallo.
 *
 * La respuesta final la construye el caso con lo que devolvieron las tools; este
 * archivo no inventa cifras.
 */
export class ScriptedEvalModel implements Model {
  readonly id = "eval-scripted";
  readonly promptVersion = "m5-v0";

  readonly #evalCase: EvalCase;
  readonly #catalog: ToolCatalog;
  #step = 0;

  constructor(evalCase: EvalCase, catalog: ToolCatalog) {
    this.#evalCase = evalCase;
    this.#catalog = catalog;
  }

  async decide(context: ModelContext): Promise<ModelDecision> {
    const step = this.#evalCase.script[this.#step];

    if (!step) {
      return {
        type: "final",
        answer: this.#evalCase.answer(context.observations),
      };
    }

    this.#step += 1;
    const tool = resolveCapability(step.capability, this.#catalog);

    return {
      type: "tool_call",
      // El contrato de `Model` se tipa con tools de lectura porque M2 solo tenia
      // esas. El gateway valida el nombre contra el catalogo completo: una tool de
      // escritura sigue pasando por allowlist, validacion y dos fases.
      tool: tool as ReadToolName,
      args: step.args,
      rationale: step.rationale,
    };
  }
}
