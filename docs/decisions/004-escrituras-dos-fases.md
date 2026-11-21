# 004 - Escrituras en dos fases con aprobación humana

> **Estado:** Aceptada
> **Fecha:** 2026-11-21
> **Decisores:** equipo del proyecto (diseño de M4, `docs/plan.md` §3.4, §4.6, §6.3 y §7)

## Contexto

M3 dejó el gateway con allowlist, validación, rate limit, redacción y audit
([ADR-003](./003-gateway-punto-unico.md), [ADR-012](./012-audit-y-rate-limit.md)). Todo lo
que existe hasta hoy es **de lectura**: las diez tools de `mcp-ops` contestan preguntas y
ninguna toca el mundo.

`docs/plan.md` §3.4 define la superficie de escritura con dos fases, §4.6 la exige como
política del gateway, §6.3 fija la semántica que hay que defender (idempotencia,
post-condición, conflicto, timeout, fallo parcial) y §7 las tablas donde esa historia vive.
`AGENTS.md` lo fija como no negociable: "Escrituras en **dos fases**: `propose_*` →
aprobación → `apply`", y "post-condición verificada tras `apply`".

Tres restricciones condicionan la forma:

1. **La identidad es server-side.** `tenant_id` y `user_id` los inyecta el borde
   autenticado. El modelo no los aporta y no puede alterarlos (ADR-003, decisión 3).
2. **El gateway es el único punto de enforcement** y solo puede importar `@beacon/core`;
   las implementaciones van en `apps/api/src/adapters` (ADR-003, decisión 5).
3. **Nada se persiste sin redacción** de secretos y PII (no negociable 7). La demo
   pública nunca escribe de verdad (no negociable 8).

## Problema

1. ¿Cómo se estructura una escritura para que sea **imposible** que se ejecute sin que un
   humano la haya aprobado, y para que el modelo no pueda saltarse esa fase?
2. ¿Qué pasa cuando la misma escritura se reintenta, cuando el proveedor contesta `409` y
   cuando contesta "timeout" sin decir si aplicó o no?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|--------|----------|-------------|
| **A. `apply` como una tool MCP más, con la aprobación como un flag que la tool comprueba** | Todo el flujo visible en la superficie MCP; pocos cambios en el orquestador | La tool tiene que poder leer la aprobación y decidir si ejecuta: eso es lógica de política dentro del servidor MCP, que no conoce el tenant ni el actor. El modelo podría invocarla en cualquier momento y la política quedaría en un `if` que nadie audita como política |
| **B. Dos fases: `propose_*` calcula y persiste un plan; `apply` es una operación interna del gateway que exige una decisión humana persistida (elegida)** | La aprobación es un hecho en la base, no un estado en memoria; el `apply` no está en ninguna allowlist, así que el modelo no lo alcanza; la idempotencia se apoya en una restricción única, no en un `if` | La fase 2 necesita su propia superficie (API/CLI/UI) y el run reanudar la aprobación; dos sitios donde se puede llamar al ejecutor |
| **C. La aprobación vive en la conversación: el agente pide permiso y el usuario contesta en el chat** | Cero esquema nuevo | La aprobación no es un hecho auditable ni idempotente: depende de que el mensaje llegue, se puede duplicar y se pierde al reanudar un run. El audit no puede probarla |

## Decisión

1. **`propose_*` son tools MCP de solo cómputo.** Calculan el plan (diff, blast radius,
   riesgo, evidencia) contra el dominio sembrado y **no mutan ni persisten nada**. La tool
   `apply` **no** se registra en `mcp-ops`: no es una tool del modelo.

2. **El gateway persiste la propuesta.** Al pasar una tool `propose_*`, el gateway guarda la
   `proposal` con el `tenant_id` que viene del contexto server-side y devuelve al
   llamante `{proposal_id, approval_id, status: "pending_approval", diff, blast_radius}`.
   La propuesta es **idempotente por argumentos**: la clave es
   `sha256(tenant_id | kind | args_canónicos)`, así que repetir la propuesta devuelve la
   misma `proposal` y el mismo `approval_id` en vez de abrir una segunda discusión.

3. **`apply` es una operación interna del gateway** (`applyApprovedAction`), no una tool y
   no está en ninguna allowlist. Solo se llega a ella por la aprobación humana.

4. **La aprobación es un hecho persistido y terminal.** `approvals` guarda `proposal_id`,
   `approver` (el **UUID** del usuario resuelto server-side, nunca un email), `decision`
   (`approved` | `rejected`), `reason` y `decided_at`. Una propuesta tiene una sola
   decisión: repetir la llamada de aprobación devuelve la existente.

5. **El efecto se reserva antes de tocar el mundo.** `action_effects` tiene
   `idempotency_key` único y la reserva se hace **antes** de llamar al ejecutor. Si la fila
   ya existe, el `apply` devuelve el efecto guardado y **no vuelve a ejecutar**. Esa es la
   garantía de idempotencia ante rettento: no es un `if`, es una restricción.

6. **Conflicto, timeout y fallo parcial se registran, no se reintentan.**
   - `409` → `status=conflict` con el estado observado. El agente reconcilia; no reintenta.
   - `timeout` → `status=timeout` con el estado observado tras consultarlo. No se asume que
     la escritura no ocurrió: se consulta antes de reintentar.
   - `partial` → `status=partial` con el subconjunto aplicado. No se reintenta a ciegas.

7. **La post-condición decide el resultado.** Si el ejecutor devuelve `applied` pero
   `verified=false`, la propuesta queda en `degraded`: nunca se reporta como éxito. Un
   efecto sin verificar es un efecto que se sabe a medias.

8. **Las dos fases van auditadas.** El audit gana seis acciones
   (`proposal.created`, `proposal.approved`, `proposal.rejected`, `action.applied`,
   `action.denied`, `action.replayed`). La cadena sigue siendo append-only y verificable
   (`beacon audit verify`): la aprobación humana queda en la historia con el mismo hash chain
   que las tool calls.

9. **Lo que se persiste es lo redactado.** Los argumentos, el diff, el blast radius y la
   evidencia se redactan antes de guardarse, y **la ejecución usa exactamente los valores
   que quedaron en la base**. Lo crudo solo existe en memoria.

Fuera de alcance de esta decisión: la reanudación del run tras la aprobación (el
orquestador v0 no reanuda; la aprobación y la ejecución se encadenan en la misma llamada
de la API), el presupuesto económico de las escrituras (M6), la compensación de un rollback
de rollback (`docs/plan.md` §6.3, punto 6) y el `SandboxExecutor` (M7, [ADR-005](./005-action-executor-puerto-adaptador.md)).

## Consecuencias

- **Positivas:** ninguna escritura ocurre sin un humano detrás; el modelo no tiene forma de
  llegar a la fase 2; el reintento es seguro por diseño (restricción única, no lógica
  condicional); la idempotencia sobrevive a un reinicio del proceso; el audit demuestra
  la secuencia completa, no solo las tool calls; el contrato de las tools de lectura no
  cambia y los evals de M3 siguen valiendo.
- **Negativas:** el flujo tiene un paso más y un estado persistente más (`waiting_approval`
  en la UI de M4b); el `apply` tiene dos caminos de entrada (la API y, más adelante, el
  worker que reanude runs) y ambos deben pasar por el mismo `applyApprovedAction`; la
  tabla `action_effects` crece con cada escritura.
- **Seguimiento:**
  - Cuando exista la cola (M4/M6), el worker que reanude un run debe llamar a
    `applyApprovedAction`, no al ejecutor: la política no se duplica.
  - La reconciliación de un `timeout` (volver a consultar el estado y cerrar el efecto) es
    una operación explícita, no un reintento automático.
  - La UI de M4b tiene que distinguir `degraded` de `applied`: es la diferencia entre
    "funcionó" y "funcionó y no lo comprobamos".

## Referencias

- Código: `packages/gateway/src/write-policy.ts`, `packages/gateway/src/apply-policy.ts`,
  `packages/core/src/schemas/writes.ts`, `packages/core/src/ports/proposal-store.ts`,
  `packages/core/src/ports/effect-ledger.ts`, `apps/api/src/http/routes.ts`,
  `infra/migrations/migrations/0006_write-proposals.sql`,
  `infra/migrations/migrations/0007_action-effects.sql`.
- Documentación: `docs/plan.md` §3.4, §4.6, §6.3, §7 y §19; `playbook/architecture.md`
  (§Capas y responsabilidades, §Principios 7); `AGENTS.md` (no negociables 1, 2, 3, 5 y 7).
- ADRs relacionados: 003 (gateway como punto único), 005 (puerto `ActionExecutor`),
  009 (migraciones), 012 (audit y rate limit).
