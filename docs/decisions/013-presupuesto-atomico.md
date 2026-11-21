# 013 - Presupuesto con reserva atomica en Postgres y liquidacion append-only

> **Estado:** Aceptada
> **Fecha:** 2026-11-22
> **Decisores:** equipo del proyecto (diseno de M6)

## Contexto

`docs/plan.md` §4.5 pide presupuesto por run y por tenant con reserva atomica antes de
la llamada y liquidacion despues, valido bajo concurrencia. §7 pide `usage_ledger`
append-only y `runs` con `cost_cents`, `tokens_in` y `tokens_out`. El DoD de M6 exige
"presupuesto correcto con 20 runs paralelos".

El modelo actual es `mock`/`eval-scripted`: no hay proveedor, no hay tokens y el coste
real es cero. La mecanica de presupuesto no puede depender de que exista un LLM.

Restricciones: el gateway solo importa `@beacon/core`; las migraciones son SQL
versionado con runner propio (ADR-009); toda llamada a tool pasa por el gateway
(ADR-003) y no se puede romper la idempotencia de las escrituras (ADR-004).

## Problema

¿Donde vive el contador del presupuesto y como se garantiza que 20 reservas
concurrentes del mismo tenant no sobrepasen el limite ni dejen reservas huerfanas?

## Opciones consideradas

| Opcion | Ventajas | Desventajas |
|--------|----------|-------------|
| **Reservas en Postgres con lock por tenant (elegida)** | Atomico entre replicas; sobrevive a reinicios; el ledger deja rastro contable; el lock por tenant protege el agregado | Serializa las reservas de un tenant; una escritura extra por tool call |
| Contadores en memoria | Sin latencia | No reparte entre replicas; un reinicio borra el consumo; imposible de auditar |
| `UPDATE ... SET n = n + 1` sin lock | Barato | Dos reservas concurrentes leen el mismo total y pueden pasarse |
| Reserva solo en el orquestador | Menos piezas | Salta si una tool se llama fuera del run (propuestas desde la API) |

## Decision

1. El puerto `BudgetPort` vive en `packages/core/src/ports/budget.ts` con cuatro
   operaciones: `reserve`, `settle`, `release` y `snapshot`.
2. La implementacion real es `DrizzleBudget` en `apps/api/src/adapters/budget.ts`. La
   comprobacion del limite y el insert ocurren en una transaccion con
   `pg_advisory_xact_lock` por tenant. El lock se toma por tenant porque el limite
   agregado es el que no puede partirse; el limite de run se comprueba dentro de la
   misma transaccion.
3. Una reserva cuenta por su estimacion mientras esta viva; al liquidar cuenta por el
   uso observado. La diferencia se libera. Una reserva viva tiene `expires_at`; la
   siguiente reserva del tenant cierra las caducadas con uso cero.
4. `(tenant_id, idempotency_key)` es unica y la liquidacion inserta una sola fila en
   `usage_ledger` por reserva. La idempotencia es una restriccion, no un `if`.
5. `usage_ledger` es append-only por trigger. Guarda `tenant_id`, `run_id`,
   `reservation_id`, `kind`, `tool`, tokens, coste y reloj. Los runs suman el uso que
   devuelve el gateway y lo persisten en `runs.cost_cents/tokens_in/tokens_out`.
6. El gateway inyecta un `ToolUsageMeter`. El medidor por defecto devuelve cero porque
   no hay LLM real; los tests inyectan un medidor determinista con precios ficticios.
   Esto separa "mecanica de presupuesto" de "coste real publicado".
7. El coste por run sale de `agents.budget_cents`; los techos de tokens y reloj, y el
   agregado del tenant, salen de configuracion validada (`BUDGET_*`).

Fuera de alcance: precios de proveedor, cached tokens y enrutado de modelo. No hay
proveedor, asi que publicar €/run distinto de 0 seria inventar.

## Consecuencias

- **Positivas:** el limite se respeta entre replicas y bajo concurrencia; no quedan
  reservas huerfanas por un proceso que muere; el gasto es auditable por run y tenant;
  la politica se prueba con fakes y la atomicidad con Postgres real.
- **Negativas:** las reservas de un tenant se serializan en la seccion critica; hay una
  escritura y una transaccion extra por tool call; el TTL de reserva debe superar el
  peor caso de una tool lenta.
- **Seguimiento:** conectar el medidor a un proveedor real cuando exista; separar la
  cola de M7 para medir encolado; decidir si el agregado por tenant necesita ventana
  temporal en vez de acumulado historico.

## Referencias

- Codigo: `packages/core/src/ports/budget.ts`, `apps/api/src/adapters/budget.ts`,
  `packages/gateway/src/gateway.ts`, `packages/orchestrator/src/orchestrator.ts`,
  `infra/migrations/migrations/0008_budget.sql`.
- Documentacion: `docs/plan.md` §4.5, §7, §10 y §14; `playbook/architecture.md`.
- ADRs relacionados: 003, 004 y 012.
