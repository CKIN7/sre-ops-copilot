# Engineering Playbook

> **Tipo:** Kit adoptado · **Proyecto:** sre-ops-copilot (Beacon) · **Revisión:** 2026-11-15

Conjunto de prácticas de ingeniería de este repositorio. Nació como kit portable y está
adaptado al stack y a las reglas de Beacon. El kit original se conserva fuera del
repositorio para reutilizarlo en otros proyectos.

## Para qué sirve

- Dejar por escrito cómo se contribuye, cómo se entrega y qué reglas de arquitectura
  se respetan.
- Servir de fuente de verdad para las skills de `.opencode/skills/`: el agente carga
  un resumen accionable y abre el documento completo solo cuando hace falta.
- Evitar que el contexto del agente se llene con documentos enteros.

## Capas del kit

| Capa | Archivo | Se consulta cuando... |
|------|---------|-----------------------|
| Contribución | [`contributing.md`](./contributing.md) | se crean ramas, commits, PRs, releases o hotfixes |
| DevOps | [`devops.md`](./devops.md) | se toca CI, Docker, deploy, secretos, migraciones o rollback |
| Arquitectura | [`architecture.md`](./architecture.md) | se agregan features, capas, paquetes, tools, colas o tests |
| Checklist de PR | [`checklists/pull-request.md`](./checklists/pull-request.md) | antes de abrir o mergear un PR |
| Checklist de release | [`checklists/release.md`](./checklists/release.md) | antes de cortar un release o un hotfix |
| Plantilla de ADR | [`_template-adr.md`](./_template-adr.md) | se registra una decisión de arquitectura |

## Stack

| Pieza | Elección |
|-------|----------|
| Lenguaje | TypeScript estricto en todo el monorepo |
| Runtime | Node 22 LTS |
| Paquetes | `pnpm` workspaces + Turborepo |
| API | Fastify |
| Web | React + Vite + TanStack Query + Tailwind |
| Base de datos | PostgreSQL 16 + Drizzle ORM |
| Cola | `pg-boss` sobre el mismo PostgreSQL |
| Contratos | Zod (y `zod-to-json-schema` para las tools MCP) |
| Protocolo de tools | MCP (`@modelcontextprotocol/sdk`), Streamable HTTP y stdio |
| Tests | Vitest |
| Observabilidad | OpenTelemetry + logs JSON (pino) |
| Contenedores | Docker multi-stage + `docker compose` local |
| Deploy | Fly.io (API y worker como procesos de la misma imagen) |

## Reglas propias de este proyecto

1. Toda llamada a una tool pasa por el **gateway**; el orquestador nunca habla directo
   con un servidor MCP.
2. Las escrituras son en **dos fases**: `propose_*` → aprobación humana → `apply`.
3. `tenant_id` y `user_id` se resuelven **server-side**; jamás vienen del modelo.
4. El **presupuesto** se reserva de forma atómica antes de cada llamada.
5. Toda acción tiene **clave de idempotencia** persistida.
6. Existe una **deny list** explícita de tools que el agente no tiene.
7. Tras un `apply`, se verifica la **post-condición**; sin verificar no es éxito.
8. Un cambio de prompt, de descripción de tool o de modelo exige **eval run**.
9. Nada se persiste sin **redacción** previa de secretos y PII.
10. La demo pública corre con `DEMO_MODE`: executor simulado, presupuestos y circuit
    breaker.

## Skills

Las skills viven en `.opencode/skills/` y son deliberadamente cortas:

| Skill | ID | Documento base |
|-------|----|----------------|
| Contribución | `contributing` | `playbook/contributing.md` |
| DevOps | `devops` | `playbook/devops.md` |
| Arquitectura | `architecture` | `playbook/architecture.md` |

**Regla de mantenimiento:** la documentación es la fuente de verdad; la skill es el
índice accionable. Si cambia una regla, se actualiza primero el documento y después el
resumen de la skill. No duplicar párrafos completos: la skill enlaza secciones.

## Cómo reutilizarlo en otro proyecto

1. Copiar `playbook/` y `.opencode/skills/` a la raíz del nuevo repositorio.
2. Reemplazar cada bloque **Contexto del proyecto** por los datos reales: runtime,
   gestor de paquetes, base de datos, ramas y comandos.
3. Ajustar los comandos de validación de `contributing.md`, `devops.md` y las skills.
4. Si el proyecto no usa `develop`, no reintroducirlo: este repo es trunk-based.
5. Registrar las decisiones propias con `_template-adr.md` en `docs/decisions/`.
6. Agregar el playbook al `AGENTS.md` del proyecto como referencia, no como copia.

## Qué conservar aunque el stack cambie

- Merge commits, commits atómicos y prohibición de reescribir historia publicada.
- Un solo artefacto inmutable por release y rollback probado.
- Migraciones compatibles hacia atrás.
- Dependencias hacia adentro y un único composition root por proceso.
- Validación en el borde, errores centralizados y SQL parametrizado.
- Healthchecks de liveness y readiness separados del rate limiter.
- Idempotencia en todo lo que se pueda reintentar.

## Convenciones de este kit

- Markdown, un tema por archivo, enlaces relativos.
- Sin secretos, hosts reales ni datos de usuarios en ejemplos.
- PowerShell como shell por defecto; se indica bash cuando el comando difiere.
- Los nombres de rama, tags y commits son ejemplos: manda la convención, no el ejemplo.
