import { createHash, timingSafeEqual } from "node:crypto";

import { AppError } from "@beacon/core/errors/app-error";

import type { PrincipalSelection } from "../application/principal-directory.js";
import type { ResolvedAuthToken } from "../config.js";

export type Authenticator = (authorization: string | undefined) => PrincipalSelection;

function unauthorized(): AppError {
  return new AppError("unauthorized", "missing or invalid bearer token", {
    statusCode: 401,
  });
}

function readBearer(header: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  const token = match?.[1];
  if (!token) {
    throw unauthorized();
  }
  return token;
}

/**
 * Compara el digest del token presentado con todos los configurados sin cortar
 * en la primera coincidencia. El valor en claro nunca se guarda ni se compara:
 * solo el SHA-256, en tiempo constante.
 */
export function createAuthenticator(tokens: readonly ResolvedAuthToken[]): Authenticator {
  return (authorization) => {
    const presented = createHash("sha256").update(readBearer(authorization)).digest();

    let matched: PrincipalSelection | undefined;
    for (const token of tokens) {
      if (timingSafeEqual(presented, token.digest)) {
        matched = token.selection;
      }
    }

    if (!matched) {
      throw unauthorized();
    }
    return matched;
  };
}