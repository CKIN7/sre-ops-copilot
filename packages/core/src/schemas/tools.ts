import { z } from "zod";

import {
  MAX_POINTS,
  MAX_STEP_SECONDS,
  MAX_WINDOW_SECONDS,
  MIN_STEP_SECONDS,
  MIN_WINDOW_SECONDS,
  parseDurationSeconds,
} from "../domain/duration.js";
import { METRIC_NAMES } from "../domain/metrics.js";
import {
  ALERT_STATUSES,
  DEFAULT_LOG_LINES,
  LOG_LEVELS,
  MAX_ALERT_WINDOW_SECONDS,
  MAX_DEPLOY_WINDOW_SECONDS,
  MAX_LOG_LINES,
  MAX_LOG_WINDOW_SECONDS,
  MAX_TRACE_WINDOW_SECONDS,
} from "../domain/read-tools.js";

const SERVICE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const DURATION_PATTERN = /^([1-9][0-9]{0,3})(s|m|h)$/;

const serviceSlugSchema = z
  .string()
  .regex(SERVICE_SLUG_PATTERN, "service must be a lowercase slug such as checkout");

const durationSchema = z.string().regex(DURATION_PATTERN, "duration must look like 30m or 6h");

interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Reglas de ventana compartidas por las tools de lectura. Se devuelven los problemas
 * en vez de lanzarlos para que cada schema los inyecte en su `superRefine`.
 */
function windowIssues(window: string, maxSeconds: number): ValidationIssue[] {
  if (!DURATION_PATTERN.test(window)) {
    return [];
  }

  const seconds = parseDurationSeconds(window);
  const issues: ValidationIssue[] = [];

  if (seconds < MIN_WINDOW_SECONDS) {
    issues.push({
      path: ["window"],
      message: `window must be at least ${MIN_WINDOW_SECONDS}s`,
    });
  }
  if (seconds > maxSeconds) {
    issues.push({
      path: ["window"],
      message: `window must not exceed ${maxSeconds}s`,
    });
  }

  return issues;
}

export const listServicesInputSchema = z.object({});

export type ListServicesInput = z.infer<typeof listServicesInputSchema>;

export const getServiceInputSchema = z.object({ name: serviceSlugSchema });

export type GetServiceInput = z.infer<typeof getServiceInputSchema>;

export const QUERY_METRICS_AGGREGATES = ["avg", "min", "max", "sum"] as const;

export type QueryMetricsAggregate = (typeof QUERY_METRICS_AGGREGATES)[number];

export const queryMetricsInputSchema = z
  .object({
    service: serviceSlugSchema,
    metric: z.enum(METRIC_NAMES),
    window: durationSchema,
    step: durationSchema,
    agg: z.enum(QUERY_METRICS_AGGREGATES).default("avg"),
  })
  .superRefine((value, ctx) => {
    for (const issue of windowIssues(value.window, MAX_WINDOW_SECONDS)) {
      ctx.addIssue({ code: "custom", ...issue });
    }

    // Si la forma no es válida, el regex ya reportó el problema.
    if (!DURATION_PATTERN.test(value.window) || !DURATION_PATTERN.test(value.step)) {
      return;
    }

    const windowSeconds = parseDurationSeconds(value.window);
    const stepSeconds = parseDurationSeconds(value.step);

    if (stepSeconds < MIN_STEP_SECONDS || stepSeconds > MAX_STEP_SECONDS) {
      ctx.addIssue({
        code: "custom",
        path: ["step"],
        message: `step must be between ${MIN_STEP_SECONDS}s and ${MAX_STEP_SECONDS}s`,
      });
    }

    if (stepSeconds > windowSeconds) {
      ctx.addIssue({
        code: "custom",
        path: ["step"],
        message: "step must not exceed window",
      });
    }

    if (windowSeconds / stepSeconds > MAX_POINTS) {
      ctx.addIssue({
        code: "custom",
        path: ["window"],
        message: `window divided by step must not exceed ${MAX_POINTS} points`,
      });
    }
  });

export type QueryMetricsInput = z.infer<typeof queryMetricsInputSchema>;

export const searchLogsInputSchema = z
  .object({
    service: serviceSlugSchema,
    query: z.string().min(1).max(200),
    window: durationSchema,
    level: z.enum(LOG_LEVELS).optional(),
    limit: z.number().int().min(1).max(MAX_LOG_LINES).default(DEFAULT_LOG_LINES),
  })
  .superRefine((value, ctx) => {
    for (const issue of windowIssues(value.window, MAX_LOG_WINDOW_SECONDS)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });

export type SearchLogsInput = z.infer<typeof searchLogsInputSchema>;

export const getDeploysInputSchema = z
  .object({
    service: serviceSlugSchema,
    window: durationSchema,
  })
  .superRefine((value, ctx) => {
    for (const issue of windowIssues(value.window, MAX_DEPLOY_WINDOW_SECONDS)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });

export type GetDeploysInput = z.infer<typeof getDeploysInputSchema>;

export const getTraceSummaryInputSchema = z
  .object({
    service: serviceSlugSchema,
    window: durationSchema,
  })
  .superRefine((value, ctx) => {
    for (const issue of windowIssues(value.window, MAX_TRACE_WINDOW_SECONDS)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });

export type GetTraceSummaryInput = z.infer<typeof getTraceSummaryInputSchema>;

export const listAlertsInputSchema = z
  .object({
    service: serviceSlugSchema.optional(),
    status: z.enum(ALERT_STATUSES).optional(),
    window: durationSchema,
  })
  .superRefine((value, ctx) => {
    for (const issue of windowIssues(value.window, MAX_ALERT_WINDOW_SECONDS)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });

export type ListAlertsInput = z.infer<typeof listAlertsInputSchema>;

export const getFeatureFlagsInputSchema = z.object({ service: serviceSlugSchema });

export type GetFeatureFlagsInput = z.infer<typeof getFeatureFlagsInputSchema>;

export const getOncallInputSchema = z.object({ service: serviceSlugSchema });

export type GetOncallInput = z.infer<typeof getOncallInputSchema>;

export const searchRunbooksInputSchema = z.object({
  query: z.string().min(2).max(100),
});

export type SearchRunbooksInput = z.infer<typeof searchRunbooksInputSchema>;

export const TOOL_INPUT_SCHEMAS = {
  list_services: listServicesInputSchema,
  get_service: getServiceInputSchema,
  query_metrics: queryMetricsInputSchema,
  search_logs: searchLogsInputSchema,
  get_deploys: getDeploysInputSchema,
  get_trace_summary: getTraceSummaryInputSchema,
  list_alerts: listAlertsInputSchema,
  get_feature_flags: getFeatureFlagsInputSchema,
  get_oncall: getOncallInputSchema,
  search_runbooks: searchRunbooksInputSchema,
} as const;

export const READ_TOOL_NAMES = Object.keys(TOOL_INPUT_SCHEMAS) as Array<
  keyof typeof TOOL_INPUT_SCHEMAS
>;
