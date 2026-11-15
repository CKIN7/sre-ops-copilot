# Beacon — SRE/Ops Copilot

> Copiloto de guardia que investiga incidentes, propone acciones con evidencia y solo
> ejecuta escrituras tras aprobación humana, con presupuesto, auditoría y evals.

**Estado:** planificación. El playbook y las decisiones están adoptados; el código
todavía no existe.

## Qué demuestra

- Un **gateway** que centraliza allowlist, presupuesto, aprobación, redacción y audit.
- **Escrituras en dos fases** con idempotencia y verificación de post-condición.
- **Evals** con golden set, fixtures y gate en CI para un sistema no determinista.
- **Demo en tres capas**: pública simulada, local con fidelidad total y replay.
- Un **executor** por puerto/adaptador: simulado por defecto, sandbox real demostrado.

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

## Cómo se valida (objetivo del scaffold)

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm db:migrate
pnpm evals
```

## Licencia

Pendiente de definir.
