import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compara el header `Authorization` con el token de servicio sin filtrar el
 * prefijo correcto por tiempo. Se comparan digests para que longitudes distintas
 * tampoco cambien el coste.
 */
export function isAuthorized(header: string | null, expectedToken: string): boolean {
  if (!header) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = match?.[1]?.trim();
  if (!presented) {
    return false;
  }

  const presentedDigest = createHash("sha256").update(presented).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}
