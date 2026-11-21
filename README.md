# Beacon — SRE/Ops Copilot

> Copiloto de guardia que investiga incidentes, propone acciones con evidencia y solo
> ejecuta escrituras tras aprobación humana, con presupuesto, auditoría y evals.

**Estado:** M4a cerrado (2026-11-21). `mcp-ops` sirve las 10 tools de lectura y las 3 de
propuesta (`propose_rollback`, `propose_set_flag`, `propose_silence_alert`) por stdio y
Streamable HTTP; el gateway aplica allowlist, validación, rate limit con ventana
deslizante, redacción y audit; el orquestador v0 ejecuta el run con write-ahead en
Postgres; la API y el CLI producen la timeline y verifican la cadena de audit. Las
escrituras van en dos fases: `propose_*` calcula un plan y el gateway lo persiste como
propuesta, y nada se ejecuta hasta que un humano la aprueba. El modelo es `mock`
guionizado: no hay LLM, tokens ni coste. Lo que sigue es M4b (UI de aprobación y
timeline) y M5 (evals).

## Qué demuestra

- Un **gateway** que centraliza allowlist, validación, presupuesto, aprobación, redacción y audit.
- **Escrituras en dos fases** con idempotencia y verificación de post-condición.
- **Evals** con golden set, fixtures y gate en CI para un sistema no determinista.
- **Demo en tres capas**: pública simulada, local con fidelidad total y replay.
- Un **executor** por puerto/adaptador: simulado por defecto, sandbox real demostrado.
- Un **audit encadenado por hash**: cada tool call deja una entrada y la cadena se
  verifica con una orden (`beacon audit verify`).

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

# Postgres local (puerto 5433 en .env)
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --wait
pnpm db:migrate
$env:SEED_SCALE="0.1"; pnpm db:seed
```

Run completo de punta a punta (tres terminales):

```powershell
# 1. mcp-ops por Streamable HTTP
pnpm --filter @beacon/mcp-ops start:http

# 2. API (Fastify + Drizzle)
pnpm start:api

# 3. CLI: lanza el run y lee su timeline de Postgres a través de la API
pnpm cli run --goal "Investiga el pico de errores 5xx en checkout"

# 4. Verifica la cadena de audit: recalcula los hashes y dice si alguien la reescribió
pnpm cli audit verify
```

Los tests de integración usan `DATABASE_URL`; sin esa variable se saltan. El run
completo necesita un seed reciente porque las tools usan ventanas relativas a `now()`.

`beacon audit verify` sale con código `1` si la cadena está rota: una manipulación
detectada es un fallo, no un aviso.

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
