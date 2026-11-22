# 016 - Benchmark reproducible y simulacro de incidente honesto

> **Estado:** Aceptada
> **Fecha:** 2026-11-22
> **Decisores:** equipo del proyecto (`docs/plan.md` §14, §15 y §17)

## Contexto

M8 pide un benchmark reproducible y un runbook con postmortem de un incidente
provocado. El proyecto no tiene LLM real, no tiene cola y el incidente se siembra
en Postgres. Publicar un p95 global o un postmortem sin etiquetar el origen seria
vender humo.

## Problema

1. ¿Como se mide la latencia de un run completo sin contaminarla con denegaciones
   de rate limit o de presupuesto?
2. ¿Como se demuestra el flujo de incidente si el modelo guionizado no propone
   acciones?
3. ¿Que se publica cuando el video de 3 minutos todavia no existe?

## Opciones consideradas

| Opcion | Ventajas | Desventajas |
|---|---|---|
| **A. Publicar el p95 de todas las peticiones** | Un solo numero | Mezcla runs `succeeded` con `rate_limited`; miente sobre la latencia |
| **B. Subir el rate limit para que todo pase** | p95 "bonito" | Desactiva el gobierno que se quiere demostrar; no es reproducible por defecto |
| **C. Separar metricas y etiquetar el simulacro (elegida)** | Honesto y reproducible; el rate limit se ve como gobierno | Requiere explicar dos numeros y el origen sintetico |

## Decision

1. **`run_complete_ms` solo suma runs `succeeded`.** `run_succeeded` reporta la
   proporcion y `rate_limited` se mide aparte. A 20 VUs se satura
   `RATE_LIMIT_TOOL=120` por minuto; para una corrida sin saturacion se usa
   `VUS=8`.
2. **El incidente del postmortem es sintetico y se etiqueta.** El run de
   investigacion es real sobre el seed; la propuesta aplicada que se cita es
   evidencia del flujo de dos fases, no una vinculacion automatica run ->
   propuesta. La reanudacion del run sigue pendiente.
3. **El video se entrega como guion, no como archivo inventado.** El guion vive
   en `docs/video-script.md`; M8 no se declara cerrado hasta que exista el video.

## Consecuencias

- **Positivas:** el benchmark no se autoengana; el rate limit aparece como una
  propiedad del sistema; el postmortem distingue dato sembrado de produccion.
- **Negativas:** hay dos numeros que explicar (p95 de runs exitosos y proporcion
  de rate-limited); el video queda como tarea humana.
- **Seguimiento:** anadir un eval que una investigacion con una propuesta; medir
  una corrida a `VUS=8`; grabar y enlazar el video.

## Evidencia

- `docs/benchmark.md` con comandos y resultados medidos.
- `docs/runbook.md` y `docs/postmortem-2026-11-22-checkout-5xx.md`.
- `infra/k6/run-api.js` corregido para no sumar runs fallidos al p95.
- `pnpm evals:gate`, `pnpm budget:concurrency` y `pnpm contract:sandbox` en verde.

## Referencias

- `docs/plan.md` §10, §14, §15, §16 y §17.
- `docs/decisions/015-sandbox-real-y-demo-mode.md`.
- `infra/k6/run-api.js`, `apps/api/src/config.ts`.
