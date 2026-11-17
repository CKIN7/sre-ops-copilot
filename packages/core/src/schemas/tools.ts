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

const SERVICE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const DURATION_PATTERN = /^([1-9][0-9]{0,3})(s|m|h)$/;

export const listServicesInputSchema = z.object({});

export type ListServicesInput = z.infer<typeof listServicesInputSchema>;

export const QUERY_METRICS_AGGREGATES = ["avg", "min", "max", "sum"] as const;

export type QueryMetricsAggregate = (typeof QUERY_METRICS_AGGREGATES)[number];

export const queryMetricsInputSchema = z
  .object({
    service: z
      .string()
      .regex(SERVICE_SLUG_PATTERN, "service must be a lowercase slug such as checkout"),
    metric: z.enum(METRIC_NAMES),
    window: z.string().regex(DURATION_PATTERN, "window must look like 30m or 6h"),
    step: z.string().regex(DURATION_PATTERN, "step must look like 1m or 5m"),
    agg: z.enum(QUERY_METRICS_AGGREGATES).default("avg"),
  })
  .superRefine((value, ctx) => {
    // Si la forma no es válida, el regex ya reportó el problema.
    if (!DURATION_PATTERN.test(value.window) || !DURATION_PATTERN.test(value.step)) {
      return;
    }

    const windowSeconds = parseDurationSeconds(value.window);
    const stepSeconds = parseDurationSeconds(value.step);

    if (windowSeconds < MIN_WINDOW_SECONDS || windowSeconds > MAX_WINDOW_SECONDS) {
      ctx.addIssue({
        code: "custom",
        path: ["window"],
        message: `window must be between ${MIN_WINDOW_SECONDS}s and ${MAX_WINDOW_SECONDS}s`,
      });
    }

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

export const TOOL_INPUT_SCHEMAS = {
  list_services: listServicesInputSchema,
  query_metrics: queryMetricsInputSchema,
} as const;
