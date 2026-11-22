import type { Principal } from "@beacon/core/domain/principal";
import type { Run, RunTimeline, RunTrigger } from "@beacon/core/domain/runs";
import { AppError } from "@beacon/core/errors/app-error";
import type { Model } from "@beacon/core/ports/model";
import type { ListRunsOptions, RunStore } from "@beacon/core/ports/run-store";
import type { ToolGateway } from "@beacon/core/ports/tool-gateway";
import { Orchestrator, type RunResult } from "@beacon/orchestrator/orchestrator";

import type { AgentBinding } from "./principal-directory.js";

/** Contexto de demo resuelto en el borde HTTP (cookie anonima + IP). */
export interface DemoRequest {
  sessionId: string;
  ip: string;
}

export type GatewayFactory = (agent: AgentBinding, demo?: DemoRequest) => ToolGateway;

export type ModelFactory = (agent: AgentBinding) => Model;

export interface RunServiceDeps {
  store: RunStore;
  createGateway: GatewayFactory;
  createModel: ModelFactory;
}

export interface StartRunCommand {
  principal: Principal;
  agent: AgentBinding;
  goal: string;
  trigger: RunTrigger;
  /** Solo en DEMO_MODE; el gateway lo usa para sesion, techo y breaker. */
  demo?: DemoRequest;
}

/**
 * Caso de uso de un run (docs/plan.md §5). La identidad llega resuelta desde el
 * borde autenticado; el modelo nunca la aporta.
 */
export class RunService {
  readonly #deps: RunServiceDeps;

  constructor(deps: RunServiceDeps) {
    this.#deps = deps;
  }

  async start(command: StartRunCommand): Promise<RunResult> {
    const orchestrator = new Orchestrator({
      model: this.#deps.createModel(command.agent),
      gateway: this.#deps.createGateway(command.agent, command.demo),
      store: this.#deps.store,
    });

    return orchestrator.run({
      tenantId: command.principal.tenantId,
      userId: command.principal.userId,
      agentId: command.principal.agentId,
      goal: command.goal,
      trigger: command.trigger,
    });
  }

  async timeline(runId: string, tenantId: string): Promise<RunTimeline> {
    const timeline = await this.#deps.store.getTimeline(runId, tenantId);
    if (!timeline) {
      throw new AppError("not_found", "run not found", { statusCode: 404 });
    }
    return timeline;
  }

  /** Runs recientes del tenant: la pantalla de inicio de la UI. */
  async list(tenantId: string, options?: ListRunsOptions): Promise<Run[]> {
    return this.#deps.store.listRuns(tenantId, options);
  }
}