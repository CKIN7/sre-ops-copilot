# AGENTS.md

Guía para agentes y personas que trabajan en este repositorio.

## Qué es

**Beacon** es un copiloto de guardia (SRE/ops): investiga incidentes sobre un stack
sembrado, propone acciones con evidencia y solo ejecuta escrituras tras aprobación
humana, con presupuesto, auditoría y evals.

La tesis del proyecto: *el gobierno es el producto; el efecto es el atrezzo*. Lo que se
demuestra es la capa que hace que un agente se pueda ejecutar en una empresa sin romper
nada ni arruinarla.

## Estado

**M5 cerrado (2026-11-21); M6 con el DoD medido (2026-11-22).** M1, M2, M3, M4a,
M4b y M5 están cerrados. M6 añade presupuesto con reserva atómica en Postgres,
`usage_ledger` append-only, spans OTel `run → step → tool_call → action_apply` y la
definición de red-team bloqueado con gate. Medido: red-team 20/20 bloqueados y
presupuesto correcto con 20 runs paralelos (`pnpm budget:concurrency`: 10 permitidos,
10 denegados, 0 reservas abiertas). El único entregable sin resultado real es k6: no
está instalado y Docker rechazó la imagen; no se publica p95 inventado. M3 dejó
`mcp-ops` con las 10 tools de lectura por stdio y Streamable HTTP con bearer de
servicio, el gateway con allowlist, validación, rate limit con ventana deslizante,
redacción y audit encadenado por hash verificable con `pnpm cli audit verify`, el
orquestador v0 con write-ahead y la API y el CLI produciendo la timeline en Postgres.
M4a añade las escrituras en dos fases: tres tools `propose_*` que solo calculan el
plan, el gateway que lo persiste como propuesta con su `approval_id`, y un `apply`
interno que no se ejecuta sin aprobación humana, es idempotente ante rettento y maneja
`409`, `timeout` y post-condición no verificada (`degraded`). El `SimulatedExecutor`
es determinista y muta estado versionado en Postgres. M4b añade `apps/web`: la UI lee
la API (nunca Postgres ni `mcp-ops`), muestra la timeline de un run con el estado de
sus escrituras y la cola de aprobaciones; aprobar desde la UI **ejecuta** el `apply`.
M5 añade `packages/evals`: 40 casos de golden set sobre los 10 arquetipos, 20 de
red-team, fixtures VCR, aserciones de final/trayectoria/invariantes, gate en CI y
meta-eval. Medido: `pass@1` 100% (60/60), `pass@5` 100% (coincide con `pass@1` por el
modelo determinista), fault-handling 5/5, false-action rate 0%, coste 0 céntimos
(no hay LLM) y red-team reportado 20/20. El meta-eval degrada `query_metrics` y lleva
`pass@1` al 0%; el control neutro sigue en 100%. No hay juez LLM: la rúbrica es
determinista.

Lo que sigue es ejecutar k6 (falta el binario) y la reanudación del run tras la
aprobación (el `apply` se encadena hoy en la misma llamada de la API). No inventar módulos, scripts ni cifras que no
existan; si algo no está implementado, decirlo.

## Stack

| Pieza | Elección |
|-------|----------|
| Lenguaje | TypeScript estricto, todo el monorepo |
| Runtime | Node 22 LTS |
| Paquetes | `pnpm` workspaces + Turborepo |
| API | Fastify |
| Web | React + Vite + TanStack Query + Tailwind |
| Base de datos | PostgreSQL 16 + Drizzle ORM |
| Cola | `pg-boss` (mismo PostgreSQL, sin Redis) |
| Contratos | Zod + `zod-to-json-schema` |
| Tools | MCP (`@modelcontextprotocol/sdk`), Streamable HTTP y stdio |
| Tests | Vitest |
| Observabilidad | OpenTelemetry + pino |
| Deploy | Fly.io; Docker multi-stage |

## Estructura objetivo

```text
apps/
  api/        Fastify: runs, aprobaciones, health
  worker/     orquestador y jobs
  web/        UI
packages/
  core/       dominio, schemas, ports, errores
  mcp-ops/    servidor MCP
  gateway/    allowlist, presupuesto, audit, redacción
  orchestrator/ loop, estado, reanudación
  executors/  simulated y sandbox
  evals/      harness, casos, fixtures, gate
infra/
  compose/  kind/  migrations/  seed/
docs/
  plan.md     plan de ejecución (v2)
  decisions/  threat-model.md  runbook.md
playbook/     proceso y arquitectura (fuente de verdad)
```

## Comandos

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test

# Evals (M5/M6): 60 casos sobre fixtures, gate de CI, meta-eval y red-team bloqueado
pnpm evals
pnpm evals:gate
pnpm evals:meta

# Presupuesto (M6): 20 reservas concurrentes contra Postgres; necesita migraciones
pnpm budget:concurrency

# k6 (M6): p95 de run completo contra el API; necesita k6 instalado
k6 run -e BEACON_TOKEN=$env:BEACON_TOKEN infra/k6/run-api.js

# Re-grabar fixtures; con DATABASE_URL usa las tools reales; sin el, el generador
# determinista del seed en un instante fijo
pnpm evals:record

# Postgres local + esquema + datos
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --wait
pnpm db:migrate
$env:SEED_SCALE="0.1"; pnpm db:seed

# Run completo: mcp-ops HTTP y API en dos terminales, CLI en la tercera
pnpm --filter @beacon/mcp-ops start:http
pnpm start:api
pnpm cli run --goal "Investiga el pico de errores 5xx en checkout"

# UI (cuarta terminal): el proxy de Vite inyecta el bearer del .env
pnpm --filter @beacon/web dev

# Escritura en dos fases: proponer y aprobar (la aprobación ejecuta el apply)
curl.exe -X POST http://127.0.0.1:3000/proposals -H "authorization: Bearer $env:BEACON_TOKEN" -H "content-type: application/json" -d '{"tool":"propose_rollback","args":{"service":"checkout","to_version":"1.41.0","reason":"pico de 5xx"}}'
curl.exe -X POST http://127.0.0.1:3000/proposals/<proposal_id>/approve -H "authorization: Bearer $env:BEACON_TOKEN" -H "content-type: application/json" -d '{"reason":"adelante"}'
```

`pnpm test` incluye integración contra `DATABASE_URL`; sin esa variable los tests que
tocan Postgres se saltan. El seed debe ser reciente: las tools usan ventanas relativas
a `now()`.

La UI (`apps/web`) habla solo con la API por `/api`; en local el proxy de Vite inyecta
el bearer del `.env` para que el token no llegue al bundle del navegador.

## No negociables

1. Toda llamada a una tool pasa por el **gateway**.
2. Escrituras en **dos fases**: `propose_*` → aprobación → `apply`.
3. `tenant_id`/`user_id` **server-side**, nunca del modelo.
4. Presupuesto con **reserva atómica**; idempotencia persistida.
5. **Deny list** explícita; post-condición verificada tras `apply`.
6. Un cambio de prompt, tool o modelo exige **eval run**.
7. Nada se persiste sin **redacción** de secretos y PII.
8. La demo pública corre con `DEMO_MODE` y nunca escribe de verdad.
9. No hay secretos en el repo; `.env.example` es la referencia.
10. Los números que se publiquen deben ser medidos y reproducibles.

## Documentación

| Necesito... | Archivo |
|-------------|---------|
| Plan de ejecución, alcance y calendario | `docs/plan.md` |
| Cómo contribuir, ramas y releases | `playbook/contributing.md` |
| CI/CD, Docker, deploy, secretos | `playbook/devops.md` |
| Arquitectura, paquetes, capas, evals | `playbook/architecture.md` |
| Checklist antes de un PR | `playbook/checklists/pull-request.md` |
| Checklist de release | `playbook/checklists/release.md` |
| Plantilla de decisión | `playbook/_template-adr.md` |
| Decisiones tomadas | `docs/decisions/README.md` |

Las skills de `.opencode/skills/` son índices accionables de esos documentos. Si una
regla cambia, se actualiza primero el documento y después la skill.

## Convenciones

- Trunk-based: `main` + `feature/*`, `fix/*`, `docs/*`, `hotfix/*`. Sin `develop`.
- Conventional Commits con ámbito de paquete (`feat(gateway): ...`).
- Merge commits, nunca squash ni rebase.
- Un commit por archivo, salvo `package.json` + `pnpm-lock.yaml`.

## Reglas para agentes

- Leer la skill correspondiente antes de tocar una superficie nueva.
- No reintroducir `engineering-playbook-kit/` en el repo: el kit portable original vive
  fuera y aquí solo se mantiene la versión adaptada en `playbook/`.
- No añadir dependencias sin justificar la frontera y el coste.
- No hardcodear tenants, credenciales ni datos de usuario.
- No declarar éxito sin verificar; si no hay tests o evals, decirlo.
- Actualizar `docs/decisions/` cuando cambie una decisión de arquitectura.
