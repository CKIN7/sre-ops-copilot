export const METRIC_NAMES = [
  "rps",
  "latency_p50",
  "latency_p95",
  "latency_p99",
  "http_5xx_rate",
  "cpu",
  "mem",
  "gc_pause",
  "db_pool_used",
  "db_pool_max",
  "queue_depth",
  "latency_downstream",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export interface MetricDefinition {
  name: MetricName;
  unit: string;
  description: string;
}

/**
 * Catálogo de métricas con semántica. Es la lista cerrada que valida el schema de
 * `query_metrics` y la base del resource `catalog://metrics` (docs/plan.md §3.2): el
 * modelo no puede inventar métricas fuera de este catálogo.
 */
export const METRICS: readonly MetricDefinition[] = [
  { name: "rps", unit: "req/s", description: "Peticiones por segundo recibidas." },
  { name: "latency_p50", unit: "ms", description: "Latencia de respuesta, percentil 50." },
  { name: "latency_p95", unit: "ms", description: "Latencia de respuesta, percentil 95." },
  { name: "latency_p99", unit: "ms", description: "Latencia de respuesta, percentil 99." },
  {
    name: "http_5xx_rate",
    unit: "ratio",
    description: "Proporción de respuestas 5xx sobre el total (0-1).",
  },
  { name: "cpu", unit: "percent", description: "Uso de CPU del proceso (0-100)." },
  { name: "mem", unit: "MiB", description: "Memoria residente del proceso." },
  { name: "gc_pause", unit: "ms", description: "Pausa de GC observada en el intervalo." },
  { name: "db_pool_used", unit: "connections", description: "Conexiones ocupadas del pool." },
  { name: "db_pool_max", unit: "connections", description: "Tamaño máximo del pool." },
  { name: "queue_depth", unit: "messages", description: "Mensajes pendientes en cola." },
  {
    name: "latency_downstream",
    unit: "ms",
    description: "Latencia observada del downstream más lento.",
  },
];
