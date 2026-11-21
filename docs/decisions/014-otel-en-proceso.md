# 014 - OTel en proceso, sin exporter externo obligatorio

> **Estado:** Aceptada
> **Fecha:** 2026-11-22
> **Decisores:** equipo del proyecto (diseno de M6)

## Contexto

`docs/plan.md` §10 pide OTel desde el primer dia con spans `run -> step -> tool_call ->
action_apply` y atributos `run_id`, `tenant_id`, `tool`, `schema_hash`, `model`,
`prompt_version` y `executor`. M6 no tiene collector ni entorno de trazas y no se
quiere anadir un exporter que no se pueda verificar en local.

## Problema

¿Como se instrumenta el camino real sin exigir un collector externo ni romper los
tests que corren sin red?

## Opciones consideradas

| Opcion | Ventajas | Desventajas |
|--------|----------|-------------|
| **API de OTel + provider solo en tests (elegida)** | Spans reales; sin red; los tests exportan a memoria y verifican nombre y atributos | En produccion, sin provider, los spans son no-op hasta que se configure uno |
| Exporter OTLP obligatorio | Trazas listas para un collector | CI y local fallan sin collector; no se puede verificar el contenido sin infra |
| Logs pino como sustituto de spans | Simple | No hay jerarquia ni atributos de traza; no cumple §10 |
| Instrumentacion propia en memoria | Sin dependencias | Otra rueda; los atributos y la semantica no son estandar |

## Decision

1. El codigo usa `@opentelemetry/api` directamente: `run` y `step` en
   `packages/orchestrator`, `tool_call` anidado en el step de tool y `action_apply` en
   `packages/gateway/src/apply-policy.ts`.
2. No se registra un provider global en `apps/api`. Sin provider, la API de OTel
   devuelve spans no-op: no hay red, no hay fallo y la instrumentacion sigue siendo la
   misma. Cuando M7 tenga collector, se registra un provider en el composition root.
3. Los tests registran un `NodeTracerProvider` con `SimpleSpanProcessor` y
   `InMemorySpanExporter`. Verifican nombres, jerarquia y atributos sin collector.
4. `schema_hash` se calcula una vez desde el JSON Schema derivado del Zod de `core`
   (`packages/core/src/schemas/schema-hash.ts`). No es una constante inventada: cambia
   si cambia el contrato de la tool.
5. pino se usa como logger estructurado de Fastify, con `redact` para authorization,
   cookies y tokens. Los spans no transportan payloads completos.

## Consecuencias

- **Positivas:** la traza se puede probar en CI y en local; no se anade deuda de infra;
  los atributos son los del plan; el hash del schema es real.
- **Negativas:** en produccion las trazas no salen a ningun sitio hasta configurar un
  provider; no hay metricas OTel de negocio todavia (solo spans), y asi se declara.
- **Seguimiento:** anadir provider y exporter OTLP en M7 junto a la demo publica;
  anadir metricas de runs/min, coste/min, approval rate y error rate por tool.

## Referencias

- Codigo: `packages/orchestrator/src/orchestrator.ts`,
  `packages/gateway/src/apply-policy.ts`, `packages/gateway/src/gateway.ts`,
  `packages/core/src/schemas/schema-hash.ts`, tests de telemetria.
- Documentacion: `docs/plan.md` §10 y §14; `playbook/architecture.md`.
- ADRs relacionados: 003, 007 y 013.
