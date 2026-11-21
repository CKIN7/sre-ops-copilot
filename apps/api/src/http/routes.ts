import { AppError } from "@beacon/core/errors/app-error";
import type { AuditLog } from "@beacon/core/ports/audit-log";
import { PROPOSAL_STATUSES } from "@beacon/core/domain/write-tools";
import { RUN_STATUSES } from "@beacon/core/domain/runs";
import { createRunInputSchema } from "@beacon/core/schemas/runs";
import { WRITE_TOOL_NAMES } from "@beacon/core/schemas/writes";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { PrincipalDirectory } from "../application/principal-directory.js";
import type { ProposalService } from "../application/proposal-service.js";
import type { RunService } from "../application/run-service.js";
import type { Authenticator } from "./auth.js";
import { parseOrThrow } from "./validation.js";

export const SERVICE_NAME = "beacon-api";

const startRunBodySchema = createRunInputSchema.extend({
  // El cliente declara el origen; no es un dato de autorización.
  trigger: z.enum(["cli", "api", "ui"]).default("api"),
});

const runParamsSchema = z.object({ id: z.uuid() });

const listRunsQuerySchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const proposalParamsSchema = z.object({ id: z.uuid() });

const proposeBodySchema = z.object({
  tool: z.enum(WRITE_TOOL_NAMES as [string, ...string[]]),
  args: z.record(z.string(), z.unknown()),
  /** Run al que se ancla la propuesta; se valida contra el tenant. */
  run_id: z.uuid().nullish(),
});

const proposalQuerySchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const decisionBodySchema = z.object({
  reason: z.string().max(500).nullish(),
});

export interface RouteDeps {
  authenticate: Authenticator;
  directory: PrincipalDirectory;
  audit: AuditLog;
  service: RunService;
  proposals: ProposalService;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /**
   * La identidad viene del token y se resuelve contra el control plane. El tenant y
   * el usuario son server-side: el cuerpo de la petición no puede cambiarlos.
   */
  const resolvePrincipal = async (authorization: string | undefined) => {
    const selection = deps.authenticate(authorization);
    const resolved = await deps.directory.resolve(selection);
    if (!resolved) {
      throw new AppError("forbidden", "token is not bound to an active principal", {
        statusCode: 403,
      });
    }
    return resolved;
  };

  app.get("/health", async () => ({ status: "ok", service: SERVICE_NAME }));

  app.post("/runs", async (request, reply) => {
    const resolved = await resolvePrincipal(request.headers.authorization);

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

  app.get("/runs", async (request) => {
    const resolved = await resolvePrincipal(request.headers.authorization);
    const query = parseOrThrow(listRunsQuerySchema, request.query);

    return { runs: await deps.service.list(resolved.principal.tenantId, query) };
  });

  app.get("/runs/:id", async (request) => {
    const resolved = await resolvePrincipal(request.headers.authorization);

    const { id } = parseOrThrow(runParamsSchema, request.params);
    const timeline = await deps.service.timeline(id, resolved.principal.tenantId);
    // Las propuestas del run cuelgan de la timeline: son las escrituras que propuso
    // y lo que pasó con ellas (plan §11).
    const proposals = await deps.proposals.forRun(id, resolved.principal.tenantId);

    return { ...timeline, proposals };
  });

  /**
   * Verificación de la cadena de audit (ADR-012): recalcula cada hash y comprueba el
   * enlace con la fila anterior. Es la prueba de que la historia no fue reescrita.
   */
  app.get("/audit/verify", async (request) => {
    await resolvePrincipal(request.headers.authorization);

    return deps.audit.verify();
  });

  // --- Escrituras en dos fases (ADR-004) --------------------------------------

  /**
   * Abre una propuesta. La tool `propose_*` no muta nada: devuelve el plan y el
   * gateway lo persiste. La propuesta queda pendiente de que un humano la apruebe.
   */
  app.post("/proposals", async (request, reply) => {
    const resolved = await resolvePrincipal(request.headers.authorization);
    const body = parseOrThrow(proposeBodySchema, request.body);

    const result = await deps.proposals.propose({
      principal: resolved.principal,
      agent: resolved.agent,
      tool: body.tool,
      args: body.args,
      runId: body.run_id ?? null,
    });

    reply.status(201).header("location", `/proposals/${result.proposal_id}`);
    return { proposal: result };
  });

  /**
   * La cola de propuestas. Cada una viene con su decisión y su efecto: la UI decide
   * sobre una lista y, después de aprobar, necesita ver qué pasó al aplicarlo.
   */
  app.get("/proposals", async (request) => {
    const resolved = await resolvePrincipal(request.headers.authorization);
    const query = parseOrThrow(proposalQuerySchema, request.query);

    const proposals = await deps.proposals.listDetails(resolved.principal.tenantId, {
      status: query.status,
      limit: query.limit,
    });
    return { proposals };
  });

  app.get("/proposals/:id", async (request) => {
    const resolved = await resolvePrincipal(request.headers.authorization);
    const { id } = parseOrThrow(proposalParamsSchema, request.params);

    return { proposal: await deps.proposals.detail(id, resolved.principal.tenantId) };
  });

  /**
   * Aprueba la propuesta y ejecuta la escritura. El `apply` es idempotente: repetir
   * esta llamada devuelve el efecto guardado, no vuelve a escribir.
   */
  app.post("/proposals/:id/approve", async (request) => {
    const resolved = await resolvePrincipal(request.headers.authorization);
    const { id } = parseOrThrow(proposalParamsSchema, request.params);
    const body = parseOrThrow(decisionBodySchema, request.body ?? {});

    const outcome = await deps.proposals.approve({
      principal: resolved.principal,
      proposalId: id,
      reason: body.reason ?? null,
    });

    return {
      proposal: await deps.proposals.detail(id, resolved.principal.tenantId),
      replayed: outcome.replayed,
    };
  });

  app.post("/proposals/:id/reject", async (request) => {
    const resolved = await resolvePrincipal(request.headers.authorization);
    const { id } = parseOrThrow(proposalParamsSchema, request.params);
    const body = parseOrThrow(decisionBodySchema, request.body ?? {});

    await deps.proposals.reject({
      principal: resolved.principal,
      proposalId: id,
      reason: body.reason ?? null,
    });

    return { proposal: await deps.proposals.detail(id, resolved.principal.tenantId) };
  });
}