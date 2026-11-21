/**
 * Fallos inyectables del executor (docs/plan.md §6.4, ADR-005 decisión 5).
 *
 * Los cinco escenarios que valen más que una llamada real: se activan a voluntad y
 * son deterministas. El CI corre sin fallos; cada eval activa el que quiere.
 */
export const FAULTS = [
  "conflict",
  "timeout",
  "partial",
  "rate_limited",
  "readiness",
] as const;

export type Fault = (typeof FAULTS)[number];

/**
 * Alias aceptados en la variable de entorno `FAULTS`. El `409` es el nombre que
 * usa el proveedor; `conflict` es el nombre del estado.
 */
const ALIASES: Record<string, Fault> = {
  "409": "conflict",
  conflict: "conflict",
  timeout: "timeout",
  partial: "partial",
  partial_success: "partial",
  rate_limited: "rate_limited",
  provider_rate_limited: "rate_limited",
  readiness: "readiness",
  readiness_never_reached: "readiness",
};

/**
 * Lee la lista de fallos del entorno. Un nombre desconocido es un error de
 * configuración: fallar al arrancar es mejor que simular mal en producción.
 */
export function parseFaults(raw: string | undefined | null): Fault[] {
  if (!raw) {
    return [];
  }

  const faults: Fault[] = [];
  for (const piece of raw.split(",")) {
    const name = piece.trim().toLowerCase();
    if (name.length === 0) {
      continue;
    }
    const fault = ALIASES[name];
    if (!fault) {
      throw new Error(`unknown fault "${name}": expected one of ${FAULTS.join(", ")}`);
    }
    if (!faults.includes(fault)) {
      faults.push(fault);
    }
  }

  return faults;
}
