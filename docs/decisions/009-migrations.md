# 009 - Migraciones: SQL versionado con runner propio

> **Estado:** Aceptada
> **Fecha:** 2026-11-17
> **Decisores:** equipo del proyecto (cierre de la decisión abierta en `docs/decisions/README.md`)

## Contexto

- PostgreSQL 16; el esquema de dominio se siembra (servicios, dependencias, series de métricas)
  y después llega el control plane (runs, steps, audit, presupuestos).
- `playbook/devops.md` §Migraciones exige migraciones versionadas en el repo, idempotentes,
  con expand/contract para cambios incompatibles, probadas desde cero y sobre datos existentes.
  La redacción previa decía "aplicadas por Drizzle, no a mano".
- El DDL de este proyecto no es trivial: PK compuesta `(service_id, metric, ts)` sobre 3.110.400
  filas, carga masiva con `unnest`, índices y políticas RLS por tenant más adelante. `pg-boss`
  gestiona su propio esquema.
- La estructura objetivo no tiene `packages/db`: el acceso a datos vive en el borde de cada
  consumidor (`mcp-ops` ahora; `api` y `worker` en sus épicas).
- Hay presupuesto de complejidad bajo: una persona, sin equipo de plataforma que mantenga
  tooling propio más allá de lo mínimo.

## Problema

¿Las migraciones se generan con `drizzle-kit` o se escriben como SQL versionado aplicado por un
runner propio?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|---|---|---|
| **SQL crudo + runner propio (elegida)** | Cero dependencias nuevas; DDL explícito (PK, `unnest`, RLS, índices especiales); una sola fuente de verdad (los `.sql`); runner de ~80 líneas auditable | Hay que mantener runner y checksums; sin generación automática desde tipos |
| `drizzle-kit@0.31.11` | Genera SQL desde un schema TS; journal y migrator integrados | Suma una devDependency; el schema TS no tiene un paquete natural donde vivir (no hay `packages/db`) y obligaría a duplicarlo o a que `mcp-ops` genere hacia `infra/`; cubre mal DDL especial y acaba necesitando migraciones custom |

## Decisión

**SQL versionado en `infra/migrations` aplicado por un runner propio:**

- Archivos `NNNN-slug.sql` ordenados lexicográficamente.
- Tabla `schema_migrations(id text primary key, checksum text, applied_at timestamptz)`.
- `pg_advisory_lock` para serializar ejecuciones concurrentes; una transacción por archivo.
- Segunda pasada: no-op. Checksum distinto sobre una migración ya aplicada: falla en vez de
  adivinar.
- El runner no conoce el dominio: solo ordena, verifica y aplica.
- **Drizzle ORM sigue siendo la decisión de capa de consulta** (`playbook/architecture.md`) y se
  introduce con la épica de persistencia (`api`/`worker`, semana 2). El scaffold actual consulta
  con SQL parametrizado vía `pg`.
- **Enmienda explícita a `playbook/devops.md` §Migraciones** en este mismo cambio: donde decía
  "aplicadas por Drizzle, no a mano" ahora dice "aplicadas por un runner propio versionado
  (ADR-009), no a mano". No hay contradicción silenciosa.

Fuera de alcance: migraciones de `pg-boss` (las gestiona la librería), data migrations complejas
(se harán como SQL versionado normal) y rollback automático de migraciones (se resuelve con
expand/contract y backup, según devops).

## Consecuencias

- **Positivas:** el esquema es legible y revisable en SQL; no se añade tooling que mantener;
  checksums detectan drift; el mismo runner sirve para CI (`migrations` desde cero y segunda
  pasada idempotente) sin cambios.
- **Negativas:** el runner es código propio que hay que testear; no hay autocompletado desde
  tipos; cuando entre Drizzle ORM habrá que vigilar el drift entre las definiciones TS y el SQL
  (se mitigará con un test de contrato contra `information_schema`).
- **Seguimiento:**
  - Test de contrato de esquema cuando exista Drizzle ORM.
  - Job `migrations` en CI cuando exista CI (devops.md ya lo exige).
  - Revisitar `drizzle-kit` si el esquema supera ~15 tablas o entra más de una persona.

## Referencias

- Código: `infra/migrations/migrations/*.sql`, `infra/migrations/src/run.ts`.
- Documentación: `playbook/devops.md` §Migraciones, `playbook/architecture.md` (persistencia),
  `docs/plan.md` §7.
- ADRs previos: 001 (stack).
