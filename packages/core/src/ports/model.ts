import type { FinalAnswer } from "../schemas/runs.js";
import type { ReadToolName } from "../schemas/tools.js";

export interface Observation {
  stepIdx: number;
  tool: ReadToolName;
  args: unknown;
  result: unknown;
}

export type ModelDecision =
  | {
      type: "tool_call";
      tool: ReadToolName;
      args: unknown;
      rationale: string;
    }
  | {
      type: "final";
      answer: FinalAnswer;
    };

export interface ModelContext {
  goal: string;
  turn: number;
  observations: Observation[];
}

/**
 * Interfaz única de modelo (docs/plan.md §5). En M2 solo existe el adaptador
 * `mock`; el adaptador live entra con presupuesto y claves en un hito posterior.
 */
export interface Model {
  readonly id: string;
  readonly promptVersion: string;
  decide(context: ModelContext): Promise<ModelDecision>;
}
