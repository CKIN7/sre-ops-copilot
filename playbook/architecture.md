# Arquitectura

> **Tipo:** Guía · **Alcance:** fronteras de paquetes, capas, contratos, errores,
> persistencia, colas y tests · **Revisión:** 2026-11-15

Reglas para que el código siga siendo testeable y modificable cuando el proyecto
crece. No impone un framework: impone una dirección de dependencias y un lugar para
cada responsabilidad.

## Contexto del proyecto

> **Adaptado a sre-ops-copilot.** Revisar si cambia el stack.

- Monorepo: `apps/` (`api`, `worker`, `web`) + `packages/` (`core`, `mcp-ops`,
  `gateway`, `orchestrator`, `executors`, `evals`).
- Runtime: Node 22 LTS + TypeScript estricto; `pnpm` workspaces + Turborepo.
- Composition roots: `apps/api/src/app.ts` (`createApp`) y
  `apps/worker/src/worker.ts` (`createWorker`).
- Capas dentro de una app: `http/` → `application/` → `domain/`; los adaptadores viven
  en el borde (`adapters/`) y las interfaces en `ports/`.
- Contratos: Zod en `packages/core/src/schemas`; tipos derivados con `z.infer`.
- Errores: `AppError` en `packages/core` + handler central en `createApp`.
- Persistencia: PostgreSQL 16 con Drizzle ORM y SQL parametrizado.
- Asíncrono: `pg-boss` sobre el mismo PostgreSQL; consumidor en `apps/worker`.
- MCP: servidor en `packages/mcp-ops`; enforcement en `packages/gateway`.
- Tests: Vitest; PostgreSQL de test en contenedor.
- Evals: `packages/evals` con fixtures grabadas y gate en CI.

---

## Fronteras entre paquetes

| Paquete | Responsabilidad | Puede importar |
|---------|-----------------|----------------|
| `core` | dominio, schemas Zod, ports, errores, tipos de tools | solo `zod` |
| `mcp-ops` | servidor MCP y handlers de las tools sobre los sistemas de dominio | `core` |
| `gateway` | allowlist, validación, presupuesto, aprobación, redacción, audit | `core` |
| `orchestrator` | loop plan→tool→observar, estado, reanudación, anti-bucle | `core` |
| `executors` | implementaciones de `ActionExecutor` (simulated, sandbox) | `core` |
| `evals` | harness, casos, fixtures, asserts, gate | `core`, `gateway`, `orchestrator`, `executors`, `mcp-ops` (tools) y `seed` (solo generador de fixtures) |
| `apps/api` | HTTP, composición del proceso | todos |
| `apps/worker` | consumo de cola, composición del proceso | todos |
| `apps/web` | UI | DTOs y tipos publicados |

Reglas:

- `core` no importa ningún otro paquete interno: es el fondo de la dependencia.
- Ningún paquete importa una app. Las apps componen; los paquetes no saben que existen.
- `web` no importa lógica de servidor: consume DTOs explícitos, no tipos internos.
- Si dos paquetes necesitan un contrato, sube a `core`; no se importan entre sí.
- Un paquete nuevo se justifica por una frontera real, no por tamaño.

### Dirección permitida

```text
HTTP → http → application → ports → adapters → DB / MCP / cola
                         ↘ domain
```

- Un handler HTTP **no** importa un repositorio ni el cliente MCP.
- Un caso de uso **no** importa Fastify, Drizzle ni el SDK de MCP.
- Un adaptador **no** decide reglas de negocio; solo traduce y ejecuta.
- `domain` no importa nada de infraestructura.
- El gateway es el único punto por el que el orquestador alcanza una tool.

## Principios

1. **Dependencias hacia adentro:** las capas externas conocen a las internas, nunca al
   revés.
2. **Un lugar para componer:** solo el composition root instancia dependencias.
3. **Contratos explícitos:** validar en el borde y tipar lo que cruza capas.
4. **Falla rápido:** configuración y dependencias se validan al arrancar.
5. **Lógica de negocio aislada:** los casos de uso no saben de HTTP ni de SQL.
6. **Cambios pequeños:** una responsabilidad por archivo y por commit.
7. **Política en un solo sitio:** allowlist, presupuesto y aprobación viven en el
   gateway, no repartidos por las tools.

## Capas y responsabilidades

| Capa | Responsabilidad | Puede importar | No debe |
|------|-----------------|----------------|---------|
| `http` | rutas, middleware, mapeo HTTP ↔ caso de uso | `application`, `schemas` | SQL, MCP, executors |
| `application` | casos de uso, transacciones, reglas de orquestación | `domain`, `ports` | Fastify, Drizzle, SDK de MCP |
| `domain` | tipos y reglas puras | nada de infraestructura | I/O |
| `ports` | interfaces de repos, executor, reloj, presupuesto | `domain` | implementaciones |
| `adapters` | Drizzle, `pg-boss`, cliente MCP, executors | `ports`, `domain` | HTTP |
| `schemas` | validación de entrada/salida | Zod | acceso a datos |
| `composition` | wiring y arranque | todo | lógica de negocio |

## Composition root

Un único módulo por proceso arma el grafo de dependencias:

```ts
export function createApp(deps?: Partial<AppDeps>) {
  const db = deps?.db ?? createDb(env.DATABASE_URL)
  const runs = deps?.runs ?? new DrizzleRunRepository(db)
  const gateway = deps?.gateway ?? createGateway({ db, audit: new AuditLog(db) })
  const service = new IncidentService(runs, gateway)
  app.post('/runs', createRunController(service))
  return { app, close: () => db.close() }
}
```

Reglas:

- Inyección por constructor, no imports globales de singletons.
- `createApp` acepta dependencias opcionales para tests (fakes).
- El arranque (`listen`, conexiones, señales) vive fuera de `createApp`.
- Cerrar recursos en `SIGTERM`/`SIGINT`: pool de Postgres, `pg-boss`, trazas.
- `createWorker` sigue la misma regla: su propio root, sus propias dependencias.
- Si el proyecto crece, dividir la composición por módulo sin cambiar la dirección.

## Contratos y validación

- El schema Zod de una tool es **la** fuente de verdad: de él salen el JSON Schema de
  MCP, el tipo del handler, la validación del gateway, el fixture de eval y el
  formulario de la UI.
- Validar en el borde: body, query, params y headers.
- Usar `parse` (lanza y devuelve el tipo) en lugar de `safeParse` + `if` repetido.
- Un schema por caso de uso; no reutilizar el de creación para actualización.
- Derivar tipos del schema (`z.infer`) para no duplicar definiciones.
- Normalizar antes de persistir (trim, lowercase de emails, fechas ISO).
- No confiar en datos del cliente **ni del modelo** para autorización, tenant ni
  importes: resolverlos desde la sesión y el servidor.

## Reglas del proyecto (no negociables)

1. **Gateway único:** ninguna llamada a tool sale del orquestador sin pasar por el
   gateway.
2. **Dos fases:** `propose_*` devuelve diff, blast radius y `approval_id`; el `apply`
   exige aprobación e idempotency key.
3. **Identidad server-side:** `tenant_id` y `user_id` se inyectan desde la sesión.
4. **Presupuesto atómico:** reserva antes de la llamada, liquidación después; válido
   bajo concurrencia.
5. **Idempotencia persistida:** misma clave, mismo efecto; nunca dos ejecuciones.
6. **Deny list:** `exec_shell`, `delete_*`, `scale_down`, `rotate_secret`,
   `query_arbitrary_sql`, `modify_iac` no existen para el agente.
7. **Post-condición:** tras `applied` se verifica readiness y métrica objetivo; si no,
   el run queda `degraded`.
8. **Evals obligatorias:** prompt, descripción de tool o modelo nuevo → eval run.
9. **Redacción:** secretos y PII se redactan antes de persistir o de volver al modelo.
10. **Egress:** ninguna tool sale a red externa salvo allowlist explícita.

## Errores

- Errores de negocio con un tipo propio (`AppError`) y un `statusCode` explícito.
- Un handler central mapea: `AppError` → su status, validación → 400, desconocido → 500.
- Los fallos de tool tienen código propio: `conflict`, `timeout`, `partial`,
  `rate_limited`, `not_found`.
- Al cliente se le devuelve un mensaje seguro; el stack y el SQL solo van al log.
- No usar `res.status(500)` disperso en handlers.
- Errores esperados no se loguean como crítico; los inesperados sí, con contexto.
- En operaciones idempotentes, distinguir “no existe” de “no autorizado” solo si el
  producto lo requiere; por defecto, no filtrar existencia.

## Persistencia

- SQL siempre parametrizado; nunca interpolar input. Con Drizzle, usar el query builder
  o `sql` con placeholders, no concatenación.
- Las transacciones se abren y cierran en el caso de uso, no en el handler HTTP.
- Los repositorios devuelven tipos de dominio, no filas crudas del driver.
- Mapear snake_case de la base a camelCase del dominio en un solo lugar.
- Paginación obligatoria en listados; límite máximo y orden estable.
- Índices alineados con las consultas reales, no con intuición.
- Evitar N+1: batch o join explícito cuando el caso lo requiera.
- Aislamiento por tenant con `tenant_id` en la consulta y, cuando aplique, RLS.
- Append-only donde importa la auditoría: `audit_log`, `usage_ledger`.

## Asíncrono y colas

- El productor (API) encola y responde; el consumidor (worker) procesa.
- `pg-boss` usa el mismo PostgreSQL: no hay Redis en este proyecto.
- Jobs idempotentes: reintentar no debe duplicar efectos.
- Reintentos con backoff y un límite; fallos permanentes a dead-letter queue.
- Registrar `jobId`, intento y correlación (`run_id`, `tenant_id`).
- Un scheduler/cron corre en una sola instancia.
- Separar colas por dominio; no un worker gigante que hace todo.
- Si un efecto externo es crítico, considerar outbox transaccional en lugar de
  encolar después del commit.
- Vigilar el crecimiento de las tablas de `pg-boss` y su política de retención.

## Configuración

- Toda la configuración por entorno, validada al arrancar con un schema Zod.
- Valores por defecto solo para desarrollo local, nunca para secretos.
- Fallar el arranque si falta una variable crítica; no arrancar “a medias”.
- Un módulo de config central; los servicios no leen `process.env` disperso.
- Flags de operación explícitos: `EXECUTOR`, `DEMO_MODE`, `REPLAY_ONLY`,
  `MODEL_MODE`, `FAULTS`.

## Testing

| Nivel | Qué prueba | Dónde |
|-------|-----------|-------|
| Unitario | reglas del dominio y casos de uso con fakes | junto al módulo |
| Integración | endpoint + PostgreSQL real en contenedor | `__tests__/` |
| Contrato | schemas de tools, serialización y `ActionExecutor` | `__tests__/` |
| Evals | trayectoria y respuesta del agente sobre fixtures | `packages/evals` |
| E2E | flujo crítico de incidente completo | suite dedicada |

Reglas:

- Base de test separada y recreada; nunca apuntar a la base de desarrollo.
- `maxWorkers: 1` en integración cuando el estado es compartido.
- Cada test crea sus datos y no depende del orden.
- Sin `sleep`: esperar condiciones o usar fake timers.
- Un test que falla debe explicar el comportamiento esperado, no la implementación.
- No mockear lo que se quiere probar; mockear solo bordes externos (modelo, MCP de
  terceros, reloj).
- Los tests de integración no llaman al modelo real: usan fixtures.

## Evals

- El golden set vive en `packages/evals/cases` y cubre 10 arquetipos de incidente.
- Cada caso define estado sembrado, prompt, trayectoria esperada, invariantes y
  presupuesto.
- Aserciones en tres niveles: respuesta final, trayectoria y invariantes.
- Fixtures grabadas para que el gate de CI sea determinista y sin coste. `pnpm
  evals:record` graba contra Postgres; sin `DATABASE_URL` regenera con el generador
  determinista del seed en un instante fijo, y esa diferencia se documenta.
- El harness ejecuta el `Orchestrator` y `createToolGateway` reales. Solo se
  sustituye el transporte (`McpTransport`): fixtures VCR o runner in-process de
  `mcp-ops`. `evals` importa `mcp-ops` por esa frontera y `seed` solo para el
  generador de fixtures; ninguna app importa `evals`.
- Gate: `pass@1` contra baseline, `false-action rate` 0, coste y latencia dentro de
  presupuesto, cero violaciones de invariante.
- Meta-eval: mutar una descripción de tool y comprobar que el harness lo detecta.
  La mutación debe cambiar la selección de tool, no solo un hash de fixture.

## Estructura y nombres

```text
apps/
  api/src/{http,application,adapters,app.ts}
  worker/src/{jobs,worker.ts}
  web/src/{pages,components,api}
packages/
  core/src/{domain,schemas,ports,errors}
  mcp-ops/src/{tools,resources,prompts,server.ts}
  gateway/src/{policy,budget,approval,audit,redaction}
  orchestrator/src/{loop,state,resume,guardrails}
  executors/src/{simulated,sandbox,faults}
  evals/src/{harness,cases,fixtures,asserts}
```

- Carpetas por capa y luego por feature cuando el volumen lo justifique.
- Un archivo, una responsabilidad principal.
- Nombres en el idioma del dominio, consistentes (no mezclar `getRun` y
  `obtenerRun`).
- Interfaces para lo que se inyecta; clases concretas para la implementación.
- Evitar barrels (`index.ts`) que oculten dependencias y generen ciclos.

## Anti-patrones

| Anti-patrón | Por qué duele | Alternativa |
|-------------|---------------|-------------|
| Handler HTTP con SQL | acopla HTTP a la base | repositorio |
| Caso de uso que importa Fastify | no se puede testear ni reutilizar | DTOs |
| Orquestador llamando a MCP directo | salta allowlist, presupuesto y audit | gateway |
| `tenant_id` desde el modelo | escalada entre tenants | sesión server-side |
| Escritura sin `propose`/`apply` | acción sin aprobación ni idempotencia | dos fases |
| `new Repository()` dentro del servicio | dependencia oculta | inyección |
| Validar dentro del caso de uso | errores tardíos | schema en el borde |
| `SELECT *` y mapeo manual repetido | columnas frágiles | proyección + mapper |
| Interpolar input en SQL | inyección | parámetros |
| Job no idempotente | duplicados al reintentar | clave de idempotencia |
| `process.env` en todas partes | config impredecible | módulo de config |
| Cambiar un prompt sin eval | regresión silenciosa | gate de evals |

## Cómo evaluar un cambio

- [ ] ¿La dependencia va en la dirección correcta?
- [ ] ¿La instancia se crea en el composition root?
- [ ] ¿El contrato está validado y tipado una sola vez en `core`?
- [ ] ¿Los errores usan el tipo y el handler central?
- [ ] ¿El SQL está parametrizado y la transacción en el caso de uso?
- [ ] ¿La tool pasa por el gateway y respeta allowlist y presupuesto?
- [ ] ¿La escritura es en dos fases, idempotente y verifica post-condición?
- [ ] ¿El job es idempotente y tiene reintentos acotados?
- [ ] ¿Hay tests en la capa correcta y eval si cambió el comportamiento del agente?
- [ ] ¿La config nueva está validada al arrancar?

## Adaptación a otro proyecto

- Cambiar los nombres de carpetas por los del framework, pero conservar la dirección
  de dependencias y el composition root.
- Si el framework impone controladores anotados (NestJS, Spring), la inyección puede
  ser por decoradores; la regla de que el handler no toca la base sigue igual.
- Si no hay ORM, mantener repositorios y SQL parametrizado.
- Si no hay colas, omitir esa sección y conservar idempotencia donde haya reintentos.
- Ajustar la estrategia de tests al runner real, manteniendo aislamiento y orden
  independiente.
