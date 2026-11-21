/**
 * Patrones de argumento compartidos por las tools de lectura y de escritura.
 *
 * Viven en `core` para que el gateway valide lo mismo que valida el servidor MCP y
 * que los evals puedan construir fixtures sin copiar las reglas: un identificador de
 * servicio o de flag es el mismo en todas las tools.
 */

/** Slug de servicio: `checkout`, `web-frontend`. */
export const SERVICE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Clave de feature flag: `checkout.new-checkout`. */
export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/**
 * Identificador de alerta. En el dataset sembrado es el `id` numérico de `alerts`,
 * que es lo que expone `list_alerts`; el nombre de la alerta se repite entre
 * servicios y no identifica una sola fila.
 */
export const ALERT_ID_PATTERN = /^[0-9]{1,19}$/;

/** Versión de despliegue: `v2.3.4` o `2.3.4`. */
export const VERSION_PATTERN = /^v?[0-9]+\.[0-9]+\.[0-9]+$/;
