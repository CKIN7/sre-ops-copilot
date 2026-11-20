import { AppError } from "@beacon/core/errors/app-error";
import type { Model } from "@beacon/core/ports/model";
import type { RunStore } from "@beacon/core/ports/run-store";
import type { AuditLog } from "@beacon/core/ports/audit-log";
import { createHttpToolGateway } from "@beacon/gateway";
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
import {
  RunService,
  type GatewayFactory,
} from "./application/run-service.js";
import { createDb, type DbHandle } from "./adapters/db.js";
import { DrizzleAuditLog } from "./adapters/audit-log.js";
import { DrizzlePrincipalDirectory } from "./adapters/principal-directory.js";
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
  gatewayFactory?: GatewayFactory;
}

export interface AppHandle {
  app: FastifyInstance;
  service: RunService;
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
  let store = options.store;
  let directory = options.directory;
  let audit = options.audit;

  if (!store || !directory || !audit) {
    dbHandle = createDb(config.databaseUrl);
    store ??= new DrizzleRunStore(dbHandle.db);
    directory ??= new DrizzlePrincipalDirectory(dbHandle.db);
    audit ??= new DrizzleAuditLog(dbHandle.db);
  }

  if (!store || !directory || !audit) {
    throw new AppError("internal", "app dependencies are incomplete");
  }

  const auditLog = audit;
  const gatewayFactory: GatewayFactory =
    options.gatewayFactory ??
    ((agent) =>
      createHttpToolGateway({
        url: config.mcpUrl,
        token: config.mcpAuthToken,
        allowedTools: agent.allowedTools,
        audit: auditLog,
        actor: `agent:${agent.name}`,
      }));

  const service = new RunService({
    store,
    createGateway: gatewayFactory,
    createModel,
  });

  const app = Fastify({ logger: options.logger ?? false });
  registerErrorHandler(app);
  registerRoutes(app, {
    authenticate: createAuthenticator(config.tokens),
    directory,
    audit: auditLog,
    service,
  });

  return {
    app,
    service,
    close: async () => {
      try {
        await app.close();
      } finally {
        await dbHandle?.close();
      }
    },
  };
}
