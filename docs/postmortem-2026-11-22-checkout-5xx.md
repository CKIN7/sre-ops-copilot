# Postmortem: pico de 5xx en checkout (simulacro)

> **Aviso de honestidad:** este incidente es **sintetico y sembrado**. No hubo
> clientes reales ni una caida de produccion. El objetivo es demostrar el
> procedimiento de investigacion, propuesta, aprobacion y verificacion de Beacon
> sobre datos reproducibles.

| Campo | Valor |
|---|---|
| Fecha del incidente | 2026-11-22 |
| Severidad | SEV-3 (simulacro) |
| Servicio afectado | `checkout` |
| Ventana del seed | 01:31-02:09 UTC |
| Deploy correlacionado | `checkout` `1.42.0`, 01:13 UTC |
| Estado | Cerrado; accion correctiva verificada en el simulador |

## Resumen

El dataset sembrado muestra un pico de `checkout/http_5xx_rate` con un maximo de
**0.042 (4,2%)** y una media de **0.0197 (1,97%)** en la ventana de dos horas
consultada. El deploy `1.42.0` de `checkout`, completado a las 01:13 UTC, es el
cambio mas reciente y coincide con el inicio del pico. El agente investiga en
modo lectura, cita la metrica y el deploy, y recomienda seguir el runbook de
rollback; no ejecuta ninguna escritura por si solo.

## Impacto

- Impacto simulado sobre el servicio `checkout` del stack sembrado.
- No hay clientes, ingresos ni datos reales afectados.
- El objetivo es medir la calidad de la investigacion y del gobierno, no la
  gravedad del fallo.

## Deteccion

- Alerta de `http_5xx_rate` por encima del umbral del servicio.
- El run de investigacion se lanza con el objetivo
  `Investiga el pico de errores 5xx en checkout`.
- No se detecto por una tool de escritura: el agente solo consulta.

## Timeline (UTC)

| Hora | Evento |
|---|---|
| 01:13 | Deploy `checkout` `1.42.0`, `rollout_status=completed` |
| 01:31 | Inicio de la ventana de incidente del seed |
| 02:09 | Fin de la ventana de incidente del seed |
| 02:23:08.579 | Inicio del run de investigacion `a54d02ef-6f8b-447b-8e2c-5f03747e6f26` |
| 02:23:08.894 | Fin del run: `succeeded`, 315 ms, coste 0 centimos |

Evidencia del run (solo lectura):

| Step | Tool | Argumentos redactados | Estado |
|---|---|---|---|
| 0 | modelo | — | — |
| 1 | `query_metrics` | `checkout/http_5xx_rate`, ventana 2 h, step 5 m, avg | `ok` |
| 2 | modelo | — | — |
| 3 | `get_deploys` | `checkout`, ventana 24 h | `ok` |
| 4 | modelo | — | — |
| 5 | `search_runbooks` | `rollback` | `ok` |
| 6 | modelo | — | final |

El run no contiene ninguna propuesta ni ningun `apply`: es investigacion pura.

## Causa raiz

En el dataset, el pico correlaciona con el deploy `checkout` `1.42.0`. El
postmortem **no afirma causalidad** a partir de una sola correlacion: la
evidencia disponible es temporal (deploy a las 01:13, pico despues) y de
magnitud (4,2% de 5xx). La causa atribuida en el simulacro es el cambio de
`1.42.0`; en un incidente real habria que confirmarlo con logs, trazas y el diff
completo del deploy.

## Respuesta

1. El agente investiga y deja la timeline persistida.
2. La recomendacion es seguir el runbook de rollback de `checkout`.
3. La escritura, si se decide, se hace en dos fases: `propose_rollback` y
   aprobacion humana. El gateway persiste la propuesta con su `approval_id`.
4. El `apply` es idempotente y verifica la post-condicion.

El modelo guionizado (`mock`) **no propone acciones** por diseno: solo investiga.
Por eso el camino de escritura se ejercito en el simulacro de M7, con esta
evidencia registrada:

| Campo | Valor |
|---|---|
| Propuesta | `dafe504f-c7a2-481c-9ebe-21c8ee3c1060` |
| Tool | `propose_rollback` |
| Target | `checkout` -> `1.41.0` |
| Riesgo | `alto` |
| Estado | `applied` |
| Aprobacion | `approved`, motivo "el pico de 5xx es real, adelante con el rollback" |
| Efecto | `action_effects` con `verified=true`, executor `simulated` |

Esta propuesta es evidencia del flujo de dos fases, no de una vinculacion
automatica con el run de investigacion. La reanudacion del run tras la
aprobacion sigue pendiente (`docs/plan.md`).

## Que funciono

- La investigacion fue **read-only**: metricas -> deploy -> runbook, sin tocar
  estado.
- La timeline quedo persistida y es auditable.
- Ninguna escritura ocurrio sin propuesta y aprobacion humanas.
- El efecto aplicado es idempotente y verificado.
- El gateway aplico allowlist, presupuesto, rate limit, redaccion y audit.

## Que mejorar

- El modelo guionizado no propone acciones; el camino de escritura se prueba
  aparte. Falta un caso de eval que una investigacion con una propuesta.
- La aprobacion ejecuta el `apply` en la misma llamada; falta reanudar el run.
- No hay enrutado automatico de alertas a un run.
- El benchmark de carga debe medir solo runs `succeeded`; a 20 VUs el rate limit
  por tool satura y una parte termina en `rate_limited`.

## Acciones de mejora

| Accion | Responsable | Estado |
|---|---|---|
| Anadir un eval de investigacion + propuesta + aprobacion | equipo de evals | pendiente |
| Reanudar el run tras la aprobacion | equipo de orquestacion | pendiente |
| Medir p95 solo de runs exitosos y documentar la saturacion del rate limit | equipo de plataforma | hecho en `infra/k6/run-api.js` |
| Grabar el video de 3 minutos | equipo del proyecto | pendiente |
| Repetir el simulacro en CI nocturno | equipo de plataforma | pendiente |

## Lecciones

- El gobierno es verificable: la evidencia esta en la timeline, la propuesta, la
  aprobacion y el efecto.
- Un run de investigacion no debe escribir; la separacion lectura/escritura
  reduce el radio de impacto.
- Publicar un p95 sin separar runs exitosos de denegaciones es enganarse: la
  latencia de un `rate_limited` no es la latencia de un run completo.
