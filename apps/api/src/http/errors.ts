import { AppError } from "@beacon/core/errors/app-error";
import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function appErrorBody(error: AppError): ErrorBody {
  // Un 5xx no filtra configuración ni SQL: el detalle va al log.
  if (error.statusCode >= 500) {
    return { error: { code: error.code, message: "internal error" } };
  }

  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

/**
 * Handler central (playbook/architecture.md §Errores): `AppError` conserva su
 * status; un 4xx del parser de Fastify no se convierte en 500; todo lo demás es
 * un 500 genérico con el stack solo en el log.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, "request failed");
      } else {
        request.log.warn({ code: error.code }, "request rejected");
      }

      if (error.code === "unauthorized") {
        reply.header("www-authenticate", "Bearer");
      }
      reply.status(error.statusCode).send(appErrorBody(error));
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: "invalid_input",
          message: "invalid request",
          details: error.issues,
        },
      });
      return;
    }

    const statusCode = (error as FastifyError).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({
        error: { code: "invalid_input", message: "invalid request" },
      });
      return;
    }

    request.log.error({ err: error }, "unhandled error");
    reply.status(500).send({
      error: { code: "internal", message: "internal error" },
    });
  });
}