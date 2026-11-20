import { AppError } from "@beacon/core/errors/app-error";
import type { AuditLog } from "@beacon/core/ports/audit-log";
import { createRunInputSchema } from "@beacon/core/schemas/runs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { PrincipalDirectory } from "../application/principal-directory.js";
import type { RunService } from "../application/run-service.js";
import type { Authenticator } from "./auth.js";
import { parseOrThrow } from "./validation.js";

export const SERVICE_NAME = "beacon-api";

const startRunBodySchema = createRunInputSchema.extend({
  // El cliente declara el origen; no es un dato de autorización.
  trigger: z.enum(["cli", "api", "ui"]).default("api"),
});

const runParamsSchema = z.object({ id: z.uuid() });

export interface RouteDeps {
  authenticate: Authenticator;
  directory: PrincipalDirectory;
  audit: AuditLog;
  service: RunService;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/health", async () => ({ status: "ok", service: SERVICE_NAME }));

  app.post("/runs", async (request, reply) => {
    const selection = deps.authenticate(request.headers.authorization);
    const resolved = await deps.directory.resolve(selection);
    if (!resolved) {
      throw new AppError("forbidden", "token is not bound to an active principal", {
        statusCode: 403,
      });
    }

    const body = parseOrThrow(startRunBodySchema, request.body);
    const result = await deps.service.start({
      principal: resolved.principal,
      agent: resolved.agent,
      goal: body.goal,
      trigger: body.trigger,
    });

    request.log.info(
      { runId: result.runId, status: result.status, turns: result.turns },
      "run terminado",
    );
    reply.status(201).header("location", `/runs/${result.runId}`);
    return { run: result };
  });

  app.get("/runs/:id", async (request) => {
    const selection = deps.authenticate(request.headers.authorization);
    const resolved = await deps.directory.resolve(selection);
    if (!resolved) {
      throw new AppError("forbidden", "token is not bound to an active principal", {
        statusCode: 403,
      });
    }

    const { id } = parseOrThrow(runParamsSchema, request.params);
    return deps.service.timeline(id, resolved.principal.tenantId);
  });

  /**
   * Verificación de la cadena de audit (ADR-012): recalcula cada hash y comprueba el
   * enlace con la fila anterior. Es la prueba de que la historia no fue reescrita.
   */
  app.get("/audit/verify", async (request) => {
    const selection = deps.authenticate(request.headers.authorization);
    const resolved = await deps.directory.resolve(selection);
    if (!resolved) {
      throw new AppError("forbidden", "token is not bound to an active principal", {
        statusCode: 403,
      });
    }

    return deps.audit.verify();
  });
}