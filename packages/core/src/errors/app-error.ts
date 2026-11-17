export type AppErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "timeout"
  | "partial"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "internal";

export interface AppErrorOptions {
  statusCode?: number;
  details?: unknown;
}

/**
 * Error de negocio con código explícito. El handler central de la API y el servidor
 * MCP traducen `code`/`statusCode`; el stack y el SQL solo van al log.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
  }
}
