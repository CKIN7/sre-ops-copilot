import type { Observation } from "@beacon/core/ports/model";
import type { ReadToolName } from "@beacon/core/schemas/tools";
import type { WriteToolName } from "@beacon/core/schemas/writes";
import type { ProposalStatus } from "@beacon/core/domain/write-tools";
import type { FinalAnswer } from "@beacon/core/schemas/runs";
import type { Fault } from "@beacon/executors/faults";

/**
 * Contratos del harness de evals (docs/plan.md §8).
 *
 * Un caso no es un prompt suelto: es un escenario con estado, trayectoria esperada,
 * respuesta esperada, invariantes, presupuesto y, si aplica, un fallo inyectado. El
 * harness ejecuta el orquestador real contra el gateway real y las tools reales (via
 * fixtures), y despues evalua tres niveles: final, trayectoria e invariantes.
 */

export const ARCHETYPES = [
  "deploy-malo",
  "latencia-downstream",
  "pool-db",
  "fuga-memoria",
  "config-mala",
  "flag-mala",
  "pico-trafico",
  "certificado",
  "falsa-alarma",
  "inyeccion",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

/** Las capacidades que el modelo de eval resuelve leyendo el catalogo de tools. */
export const CAPABILITIES = [
  "listar-servicios",
  "detalle-servicio",
  "metricas",
  "logs",
  "despliegues",
  "trazas",
  "alertas",
  "flags",
  "guardia",
  "runbooks",
  "proponer-rollback",
  "proponer-flag",
  "proponer-silencio",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface EvalStep {
  capability: Capability;
  args: Record<string, unknown>;
  /** Por que el modelo pide esta tool; queda en la trayectoria y ayuda a leerla. */
  rationale: string;
}

export type EffectStatus = "applied" | "noop" | "conflict" | "timeout" | "partial";

export interface ExpectedEffect {
  status: EffectStatus;
  verified: boolean;
  proposalStatus: ProposalStatus;
}

export interface FinalExpectations {
  /** Fragmentos que la respuesta final debe contener (normalizados, sin tildes). */
  findingIncludes: string[];
  /** Evidencia que debe citar, expresada como tools que se consultaron. */
  evidenceTools?: ReadToolName[];
  proposedActionIncludes?: string[];
  nextStepIncludes?: string[];
  minConfidence?: number;
}

export interface TrajectoryExpectations {
  /** Tools que la trayectoria debe contener, en este orden relativo. */
  requiredTools: string[];
  /** Pares `[antes, despues]` que deben aparecer en ese orden. */
  precedence?: Array<[string, string]>;
  /**
   * Conjunto de tools que el caso considera correctas. La precision de seleccion
   * de tool se mide contra este conjunto; una tool extra segura sigue contando.
   */
  expectedTools: string[];
  /** Tools que no deben aparecer nunca (ademas de la deny list global). */
  forbiddenTools?: string[];
  /** La unica escritura que el caso admite; `undefined` = ninguna. */
  writeTool?: WriteToolName;
  /** `true` en los casos de "no actuar": cualquier propose_* es un fallo. */
  noWrite?: boolean;
}

export interface EvalExpectations {
  final: FinalExpectations;
  trajectory: TrajectoryExpectations;
  apply?: ExpectedEffect;
  /** Red-team: la respuesta final debe reportar el intento de inyeccion. */
  reportInjection?: boolean;
}

export type RedTeamVector = "logs" | "runbooks" | "alerts" | "deploys";

export interface RedTeamSpec {
  vector: RedTeamVector;
  payload: string;
  /** Tools prohibidas por el caso (ademas de la deny list global). */
  forbiddenTools: string[];
}

export interface EvalCase {
  id: string;
  archetype: Archetype;
  archetypeName: string;
  title: string;
  goal: string;
  service: string;
  script: EvalStep[];
  /** Construye la respuesta final a partir de lo observado. No inventa datos. */
  answer: (observations: Observation[]) => FinalAnswer;
  expect: EvalExpectations;
  budget: {
    maxModelTurns: number;
    maxWallMs: number;
  };
  fault?: Fault;
  /** Estado inicial del ejecutor simulado para las escrituras del caso. */
  initialActionState?: Record<string, unknown>;
  fixture: "golden" | "red-team";
  redTeam?: RedTeamSpec;
}

export type AssertionLevel = "catalog" | "final" | "trajectory" | "invariant" | "apply";

export interface AssertionFailure {
  level: AssertionLevel;
  code: string;
  detail: string;
}

export interface CaseMetrics {
  turns: number;
  toolCalls: number;
  latencyMs: number;
  costCents: number;
  inventedTools: number;
  toolPrecision: number;
  falseAction: boolean;
  hasWrite: boolean;
  faultHandled: boolean | null;
}

export interface CaseResult {
  caseId: string;
  archetype: Archetype;
  title: string;
  passed: boolean;
  failures: AssertionFailure[];
  metrics: CaseMetrics;
  runStatus: string;
  errorCode: string | null;
  finalAnswer: FinalAnswer | null;
  toolCalls: string[];
  effect?: {
    status: string;
    verified: boolean;
    proposalStatus: ProposalStatus;
    replayedOnRetry: boolean;
  };
}

export interface EvalRunResult {
  cases: CaseResult[];
  metrics: EvalMetrics;
  startedAt: string;
  finishedAt: string;
}

export interface EvalMetrics {
  totalCases: number;
  passedCases: number;
  passAt1: number;
  passAt5: number;
  toolSelectionPrecision: number;
  inventedToolRate: number;
  falseActionRate: number;
  averageCostCents: number;
  p95LatencyMs: number;
  faultHandlingRate: number;
  invariantViolations: number;
  redTeamReportRate: number;
}
