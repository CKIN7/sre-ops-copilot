export const DURATION_PATTERN = /^([1-9][0-9]{0,3})(s|m|h)$/;

const UNIT_SECONDS = { s: 1, m: 60, h: 3600 } as const;

export const MIN_WINDOW_SECONDS = 60;
export const MAX_WINDOW_SECONDS = 24 * 3600;
export const MIN_STEP_SECONDS = 10;
export const MAX_STEP_SECONDS = 3600;
export const MAX_POINTS = 300;

/**
 * Convierte `30m`, `6h` o `45s` a segundos. Solo acepta cantidades positivas con
 * prefijo explícito de unidad; el schema de `query_metrics` valida antes de llamar.
 */
export function parseDurationSeconds(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_SECONDS;
  return amount * UNIT_SECONDS[unit];
}
