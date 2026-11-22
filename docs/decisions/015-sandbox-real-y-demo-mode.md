# 015 - SandboxExecutor real y `DEMO_MODE` forzado en el gateway

> **Estado:** Aceptada
> **Fecha:** 2026-11-22
> **Decisores:** equipo del proyecto (`docs/plan.md` §4.11, §6.2, §8.6, §12 y §14)

## Contexto

M4 dejó el `SimulatedExecutor` y las escrituras en dos fases. M6 dejó presupuesto
atómico, audit y OTel. El hito M7 promete dos cosas distintas que conviene no mezclar:

1. un `SandboxExecutor` real sobre `kind`/k3s, con suite de contrato que demuestre que
   el adaptador no es fake;
2. una demo pública que no pueda escribir de verdad, con techo de gasto, techo de
   sesiones y fallback a replay cuando se activa el circuit breaker.

Las restricciones siguen siendo las de siempre: la demo pública nunca ejecuta acciones
reales; el gateway es el punto único de enforcement; los evals y el CI no pueden
depender de un cluster; y ningún número se publica sin medición.

## Problema

1. ¿Cómo se implementa un ejecutor real sin cambiar el contrato de acciones ni hacer
   que la suite de PR necesite Docker?
2. ¿Dónde se enforce la política de la demo para que no sea la UI la que decida?
3. ¿Cómo se demuestra el fallback a replay sin inventar un segundo sistema?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|---|---|---|
| **A. Enforzar `DEMO_MODE` en la UI** | Menos cambios en la API | La política se puede saltar llamando a la API directamente; la UI no es un borde de seguridad |
| **B. Un proxy separado para la demo** | Aísla la demo del resto | Duplica gateway, audit, presupuesto y rate limit: dos sitios donde arreglar el mismo fallo |
| **C. Gateway con política de demo + puerto de sesión en Postgres (elegida)** | Un solo punto de enforcement; la sesión, el gasto y el breaker son estado persistido; el replay es un transporte más | Una tabla y un puerto nuevos; el `SandboxExecutor` solo cubre rollback |
| **D. Cluster real en el gate de PR** | La prueba es real en cada PR | El CI depende de Docker/kind, tarda y es flaky; el gate deja de ser rápido |

## Decisión

1. **El puerto `ActionExecutor` no cambia.** `SandboxExecutor` implementa las mismas
   firmas y devuelve los mismos `status`, `effect_id` y `verified` que el simulado.

2. **El sandbox cubre el rollback, y lo dice.** Usa `kubectl rollout undo` sobre un
   deployment con historial de ReplicaSets, resuelve la versión pedida por la anotación
   `beacon.io/version` (o el tag de la imagen) y espera readiness con timeout. Si la
   versión no existe en el historial, devuelve `conflict` con el estado observado. Si
   el rollout se aplica pero la readiness no llega, devuelve `applied` con
   `verified=false`; la política lo convierte en `degraded`. `set_flag` y
   `silence_alert` se delegan al `SimulatedExecutor` y la evidencia lo dice.

3. **La configuración del sandbox falla cerrado al arrancar.** `EXECUTOR`,
   `SANDBOX_TARGET`, `READINESS_TIMEOUT`, `SANDBOX_POLL_INTERVAL`,
   `SANDBOX_COMMAND_TIMEOUT` y `FAULTS` se validan. `SANDBOX_TARGET=compose` se acepta en
   el schema pero el constructor falla con un error explícito: no hay adaptador compose
   medido, y fingirlo sería peor que no tenerlo. `kind` y k3s comparten `kubectl`.

4. **La suite de contrato no entra en el gate de PR.** Vive en
   `packages/executors/src/contract` y corre en un workflow nocturno/manual contra un
   cluster real. Si no hay cluster, sale con `1` y el error exacto. La evidencia se
   escribe en `artifacts/` con estado antes/después, versión, readiness y duración.
   El caso 6 (flag) se etiqueta como simulado porque el sandbox no lo cubre.

5. **`DEMO_MODE` se enforce en el gateway.** La sesión anónima llega del borde HTTP
   (cookie o cabecera `x-demo-session`), nunca del modelo. El gateway:
   - aplica el techo diario y el TTL con `DemoSessionStore` (Postgres);
   - cobra steps y coste de la sesión con reserva atómica bajo lock;
   - pasa `sessionId`/`ip` al rate limiter, que reutiliza la ventana deslizante con dos
     ámbitos nuevos (`session`, `ip`);
   - si el breaker está activo o se supera el techo, cambia al `ReplayTransport` y
     deniega cualquier `propose_*`;
   - si no hay fixtures, falla cerrado en vez de llamar a `mcp-ops`.

6. **La demo no escribe de verdad.** `DEMO_MODE=1` exige `EXECUTOR=simulated` al
   arrancar. El `apply` sigue siendo humano, pero en `REPLAY_ONLY` el servicio de
   propuestas lo deniega antes del ejecutor. El efecto del rollback público sigue siendo
   estado en Postgres, no una llamada real.

7. **La IP se guarda hasheada.** Ni `demo_sessions` ni `rate_limit_events` contienen la
   IP en claro. Los datos de la demo son sintéticos y no hay credenciales reales.

## Consecuencias

- **Positivas:** la suite real no bloquea PRs; el fallback a replay es observable y no
  inventa respuestas; la demo comparte gateway, audit, presupuesto y rate limit con el
  resto del sistema; el sandbox es honesto sobre lo que cubre.
- **Negativas:** `DemoSessionStore` es un puerto nuevo con su tabla; el presupuesto por
  sesión se cobra en `demo_sessions` en lugar de reutilizar la tabla
  `budget_reservations` (el presupuesto de tenant sigue usándose); `compose` queda
  pendiente; el caso 6 del contrato es simulado.
- **Seguimiento:** implementar un adaptador compose medido antes de presentarlo como
  real; publicar el enlace al run nocturno en CI (el local ya está medido); retirar
  `REPLAY_ONLY` cuando el breaker se recupere.

## Evidencia (2026-11-22)

- `pnpm typecheck`, `pnpm build` y `pnpm lint` en verde.
- **Contrato real:** `pnpm contract:sandbox` contra `kind` -> **6/6** en 59 s; casos
  1-5 con `kubectl` real, caso 6 simulado. Evidencia versionada en
  `docs/evidence/sandbox-contract-2026-11-22T02-14-11.527Z.json`.
- **Demo:** `pnpm demo:smoke` -> `ok: true`, `replayOnly: true`, `replayCalls: 1`,
  `writeDenied: true`, steps `1111110`; sin llamar a `mcp-ops` ni escribir servicios.
- **Suite completa:** 62/62 en `apps/api` y 27/27 en `mcp-ops` con `DATABASE_URL` y
  seed reciente. `pnpm evals:gate` 60/60 y red-team 20/20; `pnpm evals:meta` detecta
  la degradación. `pnpm budget:concurrency` -> 10/10, `budgetRespected: true`.
- **Carga:** k6 con 20 VUs durante 10 s -> 252 intentos, 0% de errores HTTP,
  120 runs `succeeded` y 132 `rate_limited`; p95 de run completo exitoso 1.07 s.
  La corrección de la métrica se documenta en el ADR-016.
- **Correcciones para medir en Windows:** el contrato usa `os.tmpdir()` (antes `/tmp`
  se resolvía a `D:\tmp`) y el reset de la suite fuerza el workload con `kubectl`
  directo, porque el executor rechaza rollback durante un rollout en curso. No cambian
  el contrato del puerto ni relajan ninguna aserción.

## Referencias

- Código: `packages/executors/src/sandbox.ts`,
  `packages/executors/src/contract/sandbox-contract.ts`,
  `packages/gateway/src/gateway.ts`, `packages/core/src/ports/demo-session.ts`,
  `apps/api/src/adapters/demo-session.ts`, `apps/api/src/adapters/replay-transport.ts`.
- Documentación: `docs/plan.md` §4.11, §6, §8.6, §11.7, §12 y §14;
  `infra/kind/README.md`; `playbook/devops.md`.
- ADRs: 004, 005, 006, 012, 013 y 014.
