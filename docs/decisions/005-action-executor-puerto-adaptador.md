# 005 - `ActionExecutor` puerto/adaptador: simulado por defecto, sandbox real después

> **Estado:** Aceptada
> **Fecha:** 2026-11-21
> **Decisores:** equipo del proyecto (diseño de M4, `docs/plan.md` §6 y §19)

## Contexto

`docs/plan.md` §6.1 define el contrato de ejecución de acciones y §6.2 sus tres
implementaciones (`SimulatedExecutor`, `SandboxExecutor`, `DemoStackExecutor` opcional).
§6.3 fija la semántica que hay que defender —idempotencia, post-condición, fallo parcial,
conflicto, timeout— y §6.4 los cinco fallos deterministas que valen más que una llamada
real. §11.7 promete en la tabla de honestidad que "el efecto del rollback en demo pública"
es "estado en Postgres", y no un decir.

El puerto ya existe desde M1 en `packages/core/src/ports/action-executor.ts`, y
`packages/executors` aparece en la estructura objetivo de `AGENTS.md` y en las fronteras
entre paquetes de `playbook/architecture.md`. Falta la implementación.

Tres restricciones mandan:

1. **La demo pública nunca escribe de verdad** (no negociable 8). Un ejecutor que hable
   con un clúster real no puede ser el que corre en la demo.
2. **Los evals tienen que ser deterministas** (M5). Un ejecutor que dependa del reloj, del
   azar o de la latencia real no se puede afirmar en un golden set.
3. **`packages/gateway` solo puede importar `@beacon/core`** (ADR-003, decisión 5). La
   política de aprobación no puede conocer el ejecutor concreto.

## Problema

1. ¿Dónde vive la implementación de las acciones y cómo se separa la **política** (aprobación,
   idempotencia, post-condición) del **efecto** (mutar el estado de un sistema)?
2. ¿Cómo se demuestra el camino de los fallos feos (`409`, `timeout`, `partial`) sin
   depender de un clúster real ni de un proveedor que dé fallos intermitentes?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|--------|----------|-------------|
| **A. La implementación vive en el gateway** | Una sola pieza; el gateway decide y ejecuta | El gateway deja de ser política y pasa a hablar con sistemas; rompe la frontera del ADR-003 y hace que la suite de políticas necesite Postgres |
| **B. Puerto en `core`, adaptadores en `packages/executors`, y un puerto de estado para el ejecutor simulado (elegida)** | `core` no cambia; el gateway sigue sin conocer proveedores; la política se prueba con un ejecutor falso; el simulado es determinista y el sandbox entra después sin tocar la política | Dos piezas (puerto de estado + puerto de ejecutor) y un paquete nuevo; el estado simulado vive en Postgres y hay que sembrarlo |
| **C. La implementación vive en `mcp-ops`** | Un solo servidor con acceso a los sistemas | `mcp-ops` no conoce el tenant ni la aprobación: la política se iría dentro del servidor MCP, que es justo lo que el ADR-003 evita; y `mcp-ops` es el servidor de lectura |
| **D. Un ejecutor real (kind) desde el primer día** | La prueba es real | No hay determinismo para los evals ni para los tests; el CI dependería de un clúster; la demo pública quedaría expuesta a efectos reales |

## Decisión

1. **El puerto no cambia.** `ActionExecutor` (`rollback`, `setFlag`, `silenceAlert`) se queda
   como está en `packages/core/src/ports/action-executor.ts`. El gateway, la API y los
   evals dependen solo de esa interfaz.

2. **`packages/executors` implementa el puerto** y solo importa `@beacon/core`. Es un
   paquete nuevo justificado por una frontera real: los evals necesitan el ejecutor sin
   arrastrar la API ni el gateway.

3. **El ejecutor no habla con la base de datos.** Usa el puerto `ActionStateStore`
   (también en `core`) para leer y escribir el documento de estado versionado. El
   adaptador Drizzle (`apps/api/src/adapters/action-state.ts`) lo implementa sobre la tabla
   `simulated_state`. Así el ejecutor se prueba en memoria y el gateway no depende de
   Drizzle.

4. **El `SimulatedExecutor` es determinista.** No usa azar ni reloj para decidir: el
   resultado de la misma entrada es siempre el mismo. El tiempo entra como parámetro
   inyectable (`now`) y solo aparece en los campos de estado que lo necesitan (por ejemplo
   `silenced_until`).

5. **Los fallos se inyectan, no se esperan.** El ejecutor acepta una lista de fallos por
   constructor (`409`, `timeout`, `partial`, `rate_limited`, `readiness`), que el
   composition root lee de `FAULTS`. Un eval activa el fallo que quiere; el CI corre sin
   fallos. Los cinco escenarios de §6.4 se prueban como comportamiento, no como suerte.

6. **El `effect_id` es estable por `idempotency_key`.** Lo deriva de la clave, no de un
   UUID aleatorio: la misma clave da el mismo `effect_id`, que es lo que hace falta para
   reconciliar un reintento.

7. **La post-condición se comprueba, no se supone.** Tras aplicar, el ejecutor **relee** el
   estado y contrasta la condición (por ejemplo, que la versión del servicio sea la pedida).
   Si no se cumple, devuelve `verified=false`: el efecto se registra y la propuesta queda
   `degraded` (ADR-004, decisión 7). Nunca "aplicado y sin comprobar" como si fuera éxito.

8. **El `409` sale de un compare-and-swap por versión.** La escritura al estado es
   condicional a la versión leída. Si alguien movió el estado entre la lectura y la
   escritura, el ejecutor devuelve `conflict` con el estado observado y **no** reintenta.

9. **El `timeout` no se asume como fallo.** El ejecutor consulta el estado después de la
   llamada inconclusa y devuelve `status=timeout` con lo que observa. La política guarda
   ese efecto y un reintento del `apply` lo devuelve tal cual, sin reejecutar: reconciliar
   es una decisión de una persona, no un reintento automático.

10. **El `SandboxExecutor` entra en M7, no en M4.** `kubectl rollout undo` en `kind` más la
    espera de readiness, con su suite de contrato nocturna (plan §14, hito M7). En M4a el
    composition root solo admite `simulated`: es preferible un ejecutor verificable a uno
    declarado. `DemoStackExecutor` sigue fuera de alcance.

## Consecuencias

- **Positivas:** la política de aprobación se prueba sin Postgres, sin clúster y sin
  proveedor; los cinco fallos se reproducen a voluntad y los tests no son flaky; el
  ejecutor real entra después sin tocar ni el gateway ni la política; el "efecto" de la
  demo es real en el sentido que importa: un estado en Postgres que se puede leer y
  verificar.
- **Negativas:** un paquete nuevo (`executors`) y un puerto nuevo (`ActionStateStore`); el
  estado simulado hay que sembrarlo, si no la primera escritura crea un documento vacío; y
  el ejecutor simulado no prueba que un clúster real haga lo mismo — eso es lo que M7
  responde con la suite de contrato.
- **Seguimiento:**
  - `SandboxExecutor` (M7) debe cumplir el mismo contrato: mismas firmas, mismos
    `status`, mismo `verified`, mismo `effect_id` estable por clave.
  - La suite de contrato (`sandbox_contract_runs`, §7) ejecutará los mismos casos que los
    evals contra `kind`, para que la diferencia entre simulado y real esté medida.
  - Si la demo pública necesita mostrar un efecto real, se enseñará el estado en
    Postgres con la etiqueta de "simulado" (plan §11.7), no una llamada real.

## Referencias

- Código: `packages/core/src/ports/action-executor.ts`,
  `packages/core/src/ports/action-state.ts`, `packages/executors/src/simulated.ts`,
  `packages/executors/src/faults.ts`, `apps/api/src/adapters/action-state.ts`,
  `packages/gateway/src/apply-policy.ts`.
- Documentación: `docs/plan.md` §6.1, §6.2, §6.3, §6.4, §11.7 y §14; `AGENTS.md`
  (estructura objetivo y no negociables 5, 6, 8 y 10);
  `playbook/architecture.md` (§Fronteras entre paquetes).
- ADRs relacionados: 003 (gateway como punto único), 004 (escrituras en dos fases),
  007 (harness de evals), 009 (migraciones).
