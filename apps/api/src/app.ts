import { AppError } from "@beacon/core/errors/app-error";
import type { Model } from "@beacon/core/ports/model";
import type { RunStore } from "@beacon/core/ports/run-store";
import type { AuditLog } from "@beacon/core/ports/audit-log";
import type { ActionApplier } from "@beacon/core/ports/action-applier";
import type { ActionExecutor } from "@beacon/core/ports/action-executor";
import type { EffectLedger } from "@beacon/core/ports/effect-ledger";
import type { ProposalStore } from "@beacon/core/ports/proposal-store";
import type { RateLimiter } from "@beacon/core/ports/rate-limiter";
import { createActionApplier, createHttpToolGateway } from "@beacon/gateway";
import {
  SIMULATED_EXECUTOR_NAME,
  SimulatedExecutor,
} from "@beacon/executors/simulated";
import {
  MOCK_MODEL_ID,
  MOCK_PROMPT_VERSION,
  MockModel,
} from "@beacon/orchestrator/mock-model";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type {
  AgentBinding,
  PrincipalDirectory,
} from "./application/principal-directory.js";
import { ProposalService } from "./application/proposal-service.js";
import {
  RunService,
  type GatewayFactory,
} from "./application/run-service.js";
import { createDb, type DbHandle } from "./adapters/db.js";
import { DrizzleActionStateStore } from "./adapters/action-state.js";
import { DrizzleAuditLog } from "./adapters/audit-log.js";
import { DrizzleEffectLedger } from "./adapters/effect-ledger.js";
import { DrizzlePrincipalDirectory } from "./adapters/principal-directory.js";
import { DrizzleProposalStore } from "./adapters/proposal-store.js";
import { DrizzleRateLimiter } from "./adapters/rate-limiter.js";
import { DrizzleRunStore } from "./adapters/run-store.js";
import type { ApiConfig } from "./config.js";
import { createAuthenticator } from "./http/auth.js";
import { registerErrorHandler } from "./http/errors.js";
import { registerRoutes } from "./http/routes.js";

export interface CreateAppOptions {
  config: ApiConfig;
  /** `false` en tests; en producción, `{ level: config.logLevel }`. */
  logger?: FastifyServerOptions["logger"];
  /** Inyectables para tests; si faltan, se construyen sobre Postgres. */
  store?: RunStore;
  directory?: PrincipalDirectory;
  /** Inyectable para tests; si falta, se construye sobre Postgres. */
  audit?: AuditLog;
  /** Inyectable para tests; si falta, se construye sobre Postgres. */
  rateLimiter?: RateLimiter;
  /** Inyectable para tests; si falta, se construye sobre Postgres. */
  proposalStore?: ProposalStore;
  /** Inyectable para tests; si falta, se construye sobre Postgres. */
  effectLedger?: EffectLedger;
  /** Inyectable para tests; si falta, se construye el `SimulatedExecutor`. */
  executor?: ActionExecutor;
  /** Inyectable para tests; si falta, se construye sobre los puertos. */
  applier?: ActionApplier;
  gatewayFactory?: GatewayFactory;
}

export interface AppHandle {
  app: FastifyInstance;
  service: RunService;
  proposals: ProposalService;
  close: () => Promise<void>;
}

/**
 * En M2 el único modelo es el guionizado. Si el control plane apunta a otro
 * modelo, el run falla en vez de registrar en la timeline un modelo que no se
 * ejecutó.
 */
function createModel(agent: AgentBinding): Model {
  if (agent.model !== MOCK_MODEL_ID || agent.promptVersion !== MOCK_PROMPT_VERSION) {
    throw new AppError(
      "internal",
      `model ${agent.model}@${agent.promptVersion} is not supported in M2`,
    );
  }
  return new MockModel();
}

/**
 * Composition root de la API (playbook/architecture.md §Composition root).
 * Recibe dependencias opcionales para tests y es el único lugar que crea el pool.
 */
export function createApp(options: CreateAppOptions): AppHandle {
  const { config } = options;

  let dbHandle: DbHandle | undefined;

  // El pool se abre solo si hace falta: en los tests todas las dependencias vienen
  // inyectadas y no hay ni una conexión a Postgres.
  const db = () => {
    dbHandle ??= createDb(config.databaseUrl);
    return dbHandle.db;
  };

  const store = options.store ?? new DrizzleRunStore(db());
  const directory = options.directory ?? new DrizzlePrincipalDirectory(db());
  const auditLog = options.audit ?? new DrizzleAuditLog(db());
  const limiter = options.rateLimiter ?? new DrizzleRateLimiter(db(), config.rateLimit);
  const proposalStore = options.proposalStore ?? new DrizzleProposalStore(db());
  const effectLedger = options.effectLedger ?? new DrizzleEffectLedger(db());

  const gatewayFactory: GatewayFactory =
    options.gatewayFactory ??
    ((agent) =>
      createHttpToolGateway({
        url: config.mcpUrl,
        token: config.mcpAuthToken,
        allowedTools: agent.allowedTools,
        audit: auditLog,
        rateLimiter: limiter,
        actor: `agent:${agent.name}`,
        // Sin esta pieza, una tool de escritura no tiene dónde dejar su propuesta.
        proposals: proposalStore,
      }));

  const executor =
    options.executor ??
    new SimulatedExecutor({
      state: new DrizzleActionStateStore(db()),
      faults: config.faults,
    });

  const applier =
    options.applier ??
    createActionApplier({
      proposals: proposalStore,
      effects: effectLedger,
      executor,
      audit: auditLog,
      executorName: SIMULATED_EXECUTOR_NAME,
    });

  const service = new RunService({
    store,
    createGateway: gatewayFactory,
    createModel,
  });

  const proposals = new ProposalService({
    store: proposalStore,
    applier,
    createGateway: gatewayFactory,
  });

  const app = Fastify({ logger: options.logger ?? false });
  registerErrorHandler(app);
  registerRoutes(app, {
    authenticate: createAuthenticator(config.tokens),
    directory,
    audit: auditLog,
    service,
    proposals,
  });

  return {
    app,
    service,
    proposals,
    close: async () => {
      try {
        await app.close();
      } finally {
        await dbHandle?.close();
      }
    },
  };
}
