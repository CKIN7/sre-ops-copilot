# 010 - `get_trace_summary` se deriva de métricas: no hay tabla de trazas

> **Estado:** Aceptada
> **Fecha:** 2026-11-17
> **Decisores:** equipo del proyecto (arranque de la semana 1)

## Contexto

`docs/plan.md` §3.1 define `get_trace_summary({service, window})` con "latencia/errores por
downstream", pero §7 enumera las tablas de dominio sembradas y **no incluye ninguna tabla de
trazas**: `services`, `service_deps`, `metrics_series`, `logs`, `deploys`, `alerts`,
`feature_flags`, `runbooks`, `oncall`, `incidents`.

Ya existe `metrics_series.latency_downstream`, definida en el catálogo como "latencia
observada del downstream más lento", y cada dependencia sembrada tiene sus propias métricas
`latency_p95` y `http_5xx_rate`.

## Problema

¿Se añade una tabla de spans para servir `get_trace_summary`, o se deriva el resumen de las
métricas que ya existen?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|---|---|---|
| **Derivar de `metrics_series` + `service_deps` (elegida)** | Cero tablas nuevas; los números son coherentes con `query_metrics` (misma fuente); el contrato se puede explicar en una frase | No hay atribución por span ni percentiles por ruta; los sistemas externos (`catalog`, `auth`, `psp-mock`, `db-primary`) no tienen métricas |
| Tabla `trace_spans` sembrada | Resumen por ruta y percentiles reales | Añade una tabla fuera del modelo aprobado, cientos de miles de filas más y un generador nuevo; duplica la fuente de latencia y las dos tools pueden contradecirse |
| Tabla `trace_summaries` precalculada | Consulta trivial | Vista materializada disfrazada de tabla de dominio: dos verdades que hay que mantener sincronizadas |

## Decisión

`get_trace_summary` **no necesita tabla propia**:

- Para cada dependencia de `service_deps`: `latencyP95Ms` y `errorRate` salen del servicio
  dependencia (`latency_p95` y `http_5xx_rate` en la ventana).
- `observedDownstreamMs` sale de `metrics_series.latency_downstream` **del servicio
  consultado**, que es su propia medición hacia el downstream más lento.
- Las dependencias que no son servicios sembrados devuelven `instrumented: false` con
  `latencyP95Ms` y `errorRate` en `null`. No se inventan ceros: "no medido" no es "sano".

Ventana máxima 24h, la misma que `query_metrics`, para que dos tools no discrepen por mirar
rangos distintos.

**Consecuencia de redacción:** `search_logs` necesita redactar aunque el gateway todavía no
exista. La implementación vive en `packages/core/src/redaction/redact.ts`, es la única del
repo y el gateway la reutilizará (plan §4.7); así no hay dos definiciones de "secreto" que se
desincronicen.

Fuera de alcance: trazas reales (OpenTelemetry) y atribución por span. Si la demo necesita
una traza, se añadirá con su ADR y su tabla, no como efecto colateral de una tool.

## Consecuencias

- **Positivas:** el modelo de datos queda como está aprobado; `query_metrics` y
  `get_trace_summary` cuentan la misma historia; los externos aparecen explícitamente sin
  instrumentación en vez de con datos falsos.
- **Negativas:** no se puede responder "qué ruta del downstream falla", solo "qué downstream
  falla"; un cambio en la semántica de `latency_downstream` afecta a las dos tools.
- **Seguimiento:** si los evals piden atribución por ruta, abrir un ADR de trazas y migrar
  esta tool a la nueva fuente, manteniendo el contrato de salida.

## Referencias

- Código: `packages/mcp-ops/src/tools/get-trace-summary.ts`,
  `packages/core/src/redaction/redact.ts`.
- Documentación: `docs/plan.md` §3.1, §4.7 y §7; `playbook/architecture.md` (redacción).
- ADRs previos: 002 (MCP), 009 (migraciones).