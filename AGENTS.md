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

Repo en **fase de planificación**: aún no hay código. El playbook, los ADRs y la
estructura objetivo ya están definidos. No inventar módulos, scripts ni cifras que no
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

Objetivo del scaffold (todavía no existen):

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
pnpm db:migrate
pnpm db:seed
pnpm evals
```

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
