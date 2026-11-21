/**
 * Estado del mundo que el executor simulado muta (ADR-005 decisión 3).
 *
 * El ejecutor no habla con la base de datos: lee y escribe un documento versionado a
 * través de este puerto. Así se prueba en memoria y el gateway no depende de Drizzle.
 *
 * La escritura es un compare-and-swap por versión: si el estado se movió entre la
 * lectura y la escritura, `write` devuelve `null` y el ejecutor responde `conflict`
 * con el estado observado (ADR-005, decisión 8).
 */
export interface ActionStateDocument {
  target: string;
  state: unknown;
  version: number;
}

export interface ActionStateStore {
  /** `null` = ese objetivo todavía no tiene documento. */
  read(target: string): Promise<ActionStateDocument | null>;
  /**
   * Escribe `next` solo si el documento sigue en `expectedVersion`.
   * Devuelve `null` cuando la versión ya no coincide: nadie ha escrito mal, el mundo
   * se movió y hay que reconciliar.
   */
  write(
    target: string,
    expectedVersion: number,
    next: unknown,
  ): Promise<ActionStateDocument | null>;
}
