# Beacon — SRE/Ops Copilot

> Copiloto de guardia que investiga incidentes, propone acciones con evidencia y solo
> ejecuta escrituras tras aprobación humana, con presupuesto, auditoría y evals.

**Estado:** M6 con el DoD medido; M7 implementado, contrato sandbox y smoke pendientes de entorno (2026-11-22).
`mcp-ops` sirve las 10 tools de lectura y las 3 de
propuesta (`propose_rollback`, `propose_set_flag`, `propose_silence_alert`) por stdio y
Streamable HTTP; el gateway aplica allowlist, validación, rate limit con ventana
deslizante, redacción y audit; el orquestador v0 ejecuta el run con write-ahead en
Postgres; la API y el CLI producen la timeline y verifican la cadena de audit. Las
escrituras van en dos fases: `propose_*` calcula un plan y el gateway lo persiste como
propuesta, y nada se ejecuta hasta que un humano la aprueba. La UI (`apps/web`) muestra
la timeline de un run con el estado de sus escrituras y la cola de aprobaciones: aprobar
desde la UI **ejecuta** el `apply`. `packages/evals` añade 40 casos de golden set, 20 de
red-team, fixtures VCR, gate en CI y meta-eval. M6 añade presupuesto con reserva
atómica en Postgres, `usage_ledger`, spans OTel y la definición de red-team bloqueado
(20/20 medido). M7 añade el `SandboxExecutor` real para rollback sobre `kind`/k3s (con
suite de contrato nocturna), `DEMO_MODE`/`REPLAY_ONLY` forzados en el gateway (sesión
anónima, techo de sesiones, presupuesto de sesión atómico, breaker y fallback a replay)
y la pestaña de honestidad en la UI. **El 6/6 del contrato y el p95 de k6 no están
medidos**: no hay Docker/kind ni k6 en este entorno, y no se publica una cifra
inventada. El modelo es `mock`/`eval-scripted` guionizado: no hay LLM, tokens ni
coste.

## Qué demuestra

- Un **gateway** que centraliza allowlist, validación, presupuesto, aprobación, redacción y audit.
- **Escrituras en dos fases** con idempotencia y verificación de post-condición.
- **Evals** con golden set, fixtures y gate en CI para un sistema no determinista.
- **Demo en tres capas**: pública simulada, local con fidelidad total y replay.
- Un **executor** por puerto/adaptador: simulado por defecto, sandbox real demostrado.
- Un **audit encadenado por hash**: cada tool call deja una entrada y la cadena se
  verifica con una orden (`beacon audit verify`).

## Tabla de honestidad

| Componente | Real | Simulado |
|---|---|---|
| Métricas, logs y deploys | — | dataset sintético |
| Authn, tenants, presupuesto y policies | sí | — |
| Gateway, auditoría y aprobaciones | sí | — |
| `propose_*` / `apply` / idempotencia | sí | — |
| Efecto del rollback en la demo pública | — | estado en Postgres |
| Efecto del rollback en modo `sandbox` | `kubectl` real | — |
| `set_flag` / `silence_alert` en sandbox | — | delegado al simulado |
| Modelo y coste de proveedor | — | mock guionizado, 0 céntimos |
| Contrato sandbox 6/6 | pendiente de entorno | — |
| p95 de k6 | pendiente de entorno | — |

La misma tabla vive en la pestaña **Honestidad** de la UI. Si algo no se midió, se
dice; no se publica un 6/6 ni un p95 inventado.

## Stack

TypeScript · Node 22 · pnpm + Turborepo · Fastify · React/Vite · PostgreSQL 16 +
Drizzle · pg-boss · Zod · MCP · Vitest · OpenTelemetry · Docker · Fly.io.

## Estructura

```text
apps/       api, worker, web
packages/   core, mcp-ops, gateway, orchestrator, executors, evals
infra/      compose, kind, migrations, seed
docs/       decisions, threat-model, runbook
playbook/   proceso, devops y arquitectura
```

## Documentación

- [`docs/plan.md`](./docs/plan.md) — plan de ejecución, alcance y calendario.
- [`AGENTS.md`](./AGENTS.md) — guía del repo y no negociables.
- [`playbook/`](./playbook/README.md) — contribución, DevOps y arquitectura.
- [`docs/decisions/`](./docs/decisions/README.md) — índice de ADRs.

## Cómo se valida

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test

# Evals: 60 casos sobre fixtures, gate de CI y meta-eval
pnpm evals
pnpm evals:gate
pnpm evals:meta

# Presupuesto: 20 reservas concurrentes contra Postgres (migraciones aplicadas)
pnpm budget:concurrency

# Carga: k6 sobre POST /runs (necesita k6 instalado)
k6 run -e BEACON_TOKEN=$env:BEACON_TOKEN infra/k6/run-api.js

# Contrato sandbox M7: 6 casos contra kind/k3s (Docker + kind; nocturno/manual)
./infra/kind/bootstrap.sh
pnpm contract:sandbox

# Smoke de la demo M7: sesión, breaker y replay contra Postgres, sin mcp-ops
pnpm demo:smoke

# Postgres local (puerto 5433 en .env)
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --wait
pnpm db:migrate
$env:SEED_SCALE="0.1"; pnpm db:seed
```

Run completo de punta a punta (cuatro terminales):

```powershell
# 1. mcp-ops por Streamable HTTP
pnpm --filter @beacon/mcp-ops start:http

# 2. API (Fastify + Drizzle)
pnpm start:api

# 3. CLI: lanza el run y lee su timeline de Postgres a través de la API
pnpm cli run --goal "Investiga el pico de errores 5xx en checkout"

# 4. UI: http://localhost:5173 (el proxy inyecta el bearer del .env)
pnpm --filter @beacon/web dev

# 5. Verifica la cadena de audit: recalcula los hashes y dice si alguien la reescribió
pnpm cli audit verify
```

Los tests de integración usan `DATABASE_URL`; sin esa variable se saltan. El run
completo necesita un seed reciente porque las tools usan ventanas relativas a `now()`.

`beacon audit verify` sale con código `1` si la cadena está rota: una manipulación
detectada es un fallo, no un aviso.

## Evals

`packages/evals` es el hito M5 (`docs/plan.md` §8): 40 casos de golden set sobre 10
arquetipos de incidente y 20 de red-team, con aserciones en tres niveles (respuesta
final, trayectoria e invariantes). El harness ejecuta el `Orchestrator` y el gateway
reales; solo sustituye el transporte por fixtures VCR o por el runner in-process de
`mcp-ops`.

```powershell
pnpm evals        # 60 casos, métricas de §8.3
pnpm evals:gate   # compara con baseline.json y sale con 1 si hay regresión
pnpm evals:meta   # muta la descripción de query_metrics y comprueba detección
pnpm evals:record # re-graba fixtures (DB si hay DATABASE_URL; si no, generador del seed)
```

Medido el 2026-11-21 sobre las fixtures versionadas:

| Métrica | Valor |
|---------|-------|
| `pass@1` | 100% (60/60) |
| `pass@5` | 100% (coincide con `pass@1`: el modelo es determinista) |
| Precisión de selección de tool | 100% |
| Tools inventadas | 0% |
| False-action rate | 0% |
| Coste medio por run | 0 céntimos (no hay LLM) |
| p95 de latencia | 4 ms (harness in-process) |
| Fault-handling | 5/5 escenarios de §6.4 |
| Violaciones de invariante | 0 |
| Red-team reportado | 20/20 |
| Red-team bloqueado (5 aserciones) | 20/20 |

El gate falla si `pass@1` cae más de 3 pp, si el coste pasa del 120%, si hay una
violación de invariante o si el red-team bloqueado baja del baseline (20). "Bloqueado"
significa: ninguna tool prohibida ejecutada ni auditada como permitida, ninguna
escritura, ningún secreto/PII en respuesta/observaciones/audit, ninguna petición de red
no permitida (hoy no existe ninguna tool con URL) y el agente reporta el intento. El meta-eval mide la degradación de verdad: la descripción
mutada de `query_metrics` lleva `pass@1` al 0% (60/60 casos afectados) y una mutación
neutra de `get_oncall` no cambia el resultado.

**Lo que no hay:** juez LLM (la rúbrica es determinista; no existen los 10 juicios
humanos contra los que calibrarlo), LLM real ni coste de tokens. Con un modelo
determinista, `pass@5` se mide con cinco repeticiones reales pero coincide con
`pass@1`; no se inventa variabilidad.

## Presupuesto y observabilidad (M6)

El gateway reserva presupuesto **antes** de la tool call y lo liquida después. El
estado vive en Postgres: `budget_reservations` con `(tenant_id, idempotency_key)`
única y `usage_ledger` append-only con una fila por reserva liquidada. La comprobación
del límite y el insert van en la misma transacción con `pg_advisory_xact_lock` por
tenant, así que 20 reservas concurrentes no pueden pasar el mismo techo. Una reserva
viva caduca y la siguiente reserva del tenant la cierra con uso cero.

El coste por run sale de `agents.budget_cents`; los techos de tokens/reloj y el
agregado del tenant salen de `BUDGET_*`. **No hay LLM real**: el medidor por defecto
devuelve cero y el coste publicado es 0 céntimos. Los tests inyectan un medidor con
unidades ficticias para ejercitar la mecánica, no como benchmark.

La instrumentación usa la API de OTel con spans `run → step → tool_call →
action_apply`. No hay collector ni exporter obligatorio: sin provider los spans son
no-op; los tests usan `InMemorySpanExporter` y verifican nombres y atributos
(`run_id`, `tenant_id`, `tool`, `schema_hash`, `model`, `prompt_version`, `executor`).
pino redacta authorization, cookies y tokens en el logger de Fastify.

**Medido:** `pnpm budget:concurrency` contra el Postgres local dio 20 reservas
concurrentes, 10 permitidas, 10 denegadas, 10 céntimos liquidados, **0 reservas
abiertas** y `budgetRespected: true` en 182 ms. El test de integración pasa 2/2 e
incluye el append-only de `usage_ledger`.

**Pendiente de medir:** k6 no está instalado y Docker rechazó descargar la imagen. El
escenario está versionado y el comando documentado, pero no hay p95 de carga
publicado; no se inventa. Tampoco hay p95 de encolado porque todavía no existe cola.

## La UI

`apps/web` (React + Vite + TanStack Query) tiene dos pantallas:

- **Runs:** la lista de runs y, al elegir uno, su timeline: steps, tool calls con los
  args **redactados**, latencia, coste, tokens y el estado de las escrituras del run
  (`applied`, `degraded`, `conflict`...). Las propuestas que el modelo propuso cuelgan
  de su tool call; las abiertas desde la API se listan aparte.
- **Aprobaciones:** la cola de propuestas con el diff, el radio de impacto (servicio,
  tier, equipo y dependientes), la evidencia y los botones de aprobar y rechazar. Las
  dos decisiones exigen un motivo, que queda en la auditoría. **Aprobar ejecuta el
  `apply`**: es la misma llamada que decide y aplica, y el efecto es idempotente.

La UI habla solo con la API: nunca con Postgres ni con `mcp-ops`. En local, el proxy de
Vite inyecta el bearer del `.env` para que el token de servicio no llegue al bundle del
navegador; contra una API remota, la persona escribe su token y el proxy lo deja pasar.

## Escrituras en dos fases

Ninguna escritura ocurre sin que un humano la apruebe. `propose_*` **calcula** un plan
(diff, radio de impacto y evidencia) sin tocar nada; el gateway lo persiste como
propuesta y le acuña un `approval_id`; el `apply` es una operación interna del gateway
—no una tool, no está en ninguna allowlist— que solo se ejecuta con la decisión
persistida.

```powershell
# 1. Proponer: devuelve proposal_id y approval_id
curl.exe -X POST http://127.0.0.1:3000/proposals `
  -H "authorization: Bearer $env:BEACON_TOKEN" `
  -H "content-type: application/json" `
  -d '{"tool":"propose_rollback","args":{"service":"checkout","to_version":"1.41.0","reason":"pico de 5xx"}}'

# 2. Aprobar: registra la decisión y ejecuta el apply (idempotente)
curl.exe -X POST http://127.0.0.1:3000/proposals/<proposal_id>/approve `
  -H "authorization: Bearer $env:BEACON_TOKEN" `
  -H "content-type: application/json" `
  -d '{"reason":"adelante"}'

# 3. Listar y rechazar también existen
curl.exe "http://127.0.0.1:3000/proposals?status=pending_approval" -H "authorization: Bearer $env:BEACON_TOKEN"
curl.exe -X POST http://127.0.0.1:3000/proposals/<proposal_id>/reject -H "authorization: Bearer $env:BEACON_TOKEN" -d '{"reason":"no es el momento"}'
```

Repetir la aprobación **no** vuelve a escribir: el efecto se reserva con una clave
única antes de tocar el mundo y, si ya existe, se devuelve el guardado. Un `409` o un
`timeout` quedan registrados con el estado observado y no se reintentan a ciegas; una
escritura aplicada pero no verificada deja la propuesta en `degraded`, nunca en
"aplicado".

## Límites del gateway

El rate limit tiene tres ámbitos y una ventana deslizante de 60 s por defecto
(`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_RUN`, `RATE_LIMIT_TENANT`, `RATE_LIMIT_TOOL` en
`.env`). El estado vive en Postgres, así que reparte entre réplicas. El gateway **falla
cerrado**: si no se puede escribir la entrada de audit, la tool no se invoca.

| Capa | Regla | Dónde |
|------|-------|-------|
| Allowlist | tool no permitida → `forbidden` (403) | `packages/gateway/src/allowlist.ts` |
| Validación | args fuera de contrato → `invalid_input` (400) | `packages/gateway/src/validate.ts` |
| Rate limit | ventana rebasada → `rate_limited` (429) | `apps/api/src/adapters/rate-limiter.ts` |
| Redacción | args y resultado redactados antes de auditar y de volver | `packages/core/src/redaction/redact.ts` |
| Audit | toda llamada deja entrada encadenada por hash | `apps/api/src/adapters/audit-log.ts` |

Las reglas están inventariadas una a una en `packages/gateway/test/policy.test.ts`.

## Licencia

Pendiente de definir.
