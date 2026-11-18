/**
 * Hechos y límites de las tools de lectura de `docs/plan.md` §3.1. Viven en `core`
 * para que gateway, servidor MCP y evals apliquen la misma semántica: el modelo no
 * puede inventar niveles de log, estados de alerta ni ventanas mayores.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const ALERT_STATUSES = ["firing", "acknowledged", "resolved"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_SEVERITIES = ["page", "ticket", "info"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ROLLOUT_STATUSES = ["completed", "in_progress", "rolled_back", "failed"] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

/** `search_logs`: 50 líneas como máximo por respuesta, 20 por defecto. */
export const MAX_LOG_LINES = 50;
export const DEFAULT_LOG_LINES = 20;

/** `search_runbooks`: el contrato del plan no expone `limit`; se acota a 5. */
export const MAX_RUNBOOK_RESULTS = 5;

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * `get_deploys` y `list_alerts` miran 30 días porque el dataset sembrado cubre 30
 * días y son señales de baja frecuencia; métricas, logs y trazas se quedan en 24h
 * porque son señales de alta frecuencia.
 */
export const MAX_DEPLOY_WINDOW_SECONDS = 30 * DAY;
export const MAX_ALERT_WINDOW_SECONDS = 30 * DAY;
export const MAX_LOG_WINDOW_SECONDS = 24 * HOUR;
export const MAX_TRACE_WINDOW_SECONDS = 24 * HOUR;
