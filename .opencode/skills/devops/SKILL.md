---
name: DevOps
description: CI/CD con pnpm y Postgres, contenedores, secretos, migraciones, deploy en Fly.io, rollback, observabilidad y operación de la demo. Úsala al tocar workflows de GitHub Actions, Dockerfile, compose, pipelines, deploy, variables de entorno o runbooks.
---

# DevOps

Resumen accionable de entrega y operación. **Fuente de verdad:** `playbook/devops.md`
(desde la raíz del repo). Abrir solo la sección necesaria.

## Cuándo usarla

- Editar `.github/workflows/*.yml`, `Dockerfile`, `.dockerignore` o compose.
- Cambiar tags, registro, deploy, healthchecks o rollback.
- Agregar o rotar secretos y variables de entorno.
- Diseñar migraciones que se aplican en producción.
- Operar `DEMO_MODE`, presupuestos o el circuit breaker.

## Reglas no negociables

- **Build once, deploy anywhere:** la misma imagen se valida, publica y despliega.
- Tags inmutables: el deploy usa `sha-<full>` o `X.Y.Z`, nunca solo `latest`.
- Configuración por entorno; secretos fuera de la imagen y del repo.
- Migraciones idempotentes y compatibles hacia atrás (expand/contract).
- Rollback probado antes de considerar el release listo.
- Healthchecks `GET /health` (liveness) y `GET /health/ready` (Postgres + cola) fuera
  del rate limiter.
- Permisos de workflow explícitos; usuario no root en contenedores.
- La demo pública nunca ejecuta escrituras reales.

## Pipeline mínimo

| Job | Valida |
|-----|--------|
| `build` | `pnpm install --frozen-lockfile` + `typecheck` + `build` |
| `test` | unitarios + integración con `postgres:16` como service |
| `migrations` | desde cero y segunda pasada idempotente |
| `evals` | golden set sobre fixtures, sin coste de API |
| `docker` | build de imagen (push solo en `main`/tags) |

- `concurrency` cancela runs viejos en CI; en release `cancel-in-progress: false`.
- No usar `sleep`: healthchecks de services.
- Cachear store de pnpm y capas (`type=gha`).

## Evals en CI

- Falla si `pass@1` cae >3 puntos vs baseline, si el coste >120% o si hay violación de
  invariante.
- Inyecciones de prompt: 20/20 bloqueadas.
- La suite de contrato contra sandbox `kind` es nocturna, no bloquea PRs.

## Tags de imagen

| Evento | Tags |
|--------|------|
| PR | build sin push |
| `main` | `sha-<full>`, `latest` |
| `vX.Y.Z` | `sha-<full>`, `X.Y.Z` |

## Deploy

```text
publicar imagen → migraciones one-shot → flyctl deploy --image :sha-<full>
→ readiness check (GET /health/ready) con timeout
```

- Fallar si cualquier paso devuelve código distinto de cero.
- Environment `production` con aprobación y secretos propios.
- Scheduler de `pg-boss` en una sola réplica.
- Puertos: API `3000`, MCP `4000`.

## Rollback

1. Fijar el `IMAGE_TAG` anterior.
2. `flyctl deploy --image ...:sha-<anterior>`.
3. Verificar readiness.
4. Si la migración no es reversible: restaurar backup y documentar el incidente.

## Migraciones

- Drizzle, versionadas, idempotentes, probadas desde cero y sobre datos existentes.
- Nunca `DROP`/`RENAME` en el mismo release que el código que los usa.
- La versión anterior debe poder leer el esquema nuevo.

## Operación de la demo

- `DEMO_MODE`: allowlist de lectura + `propose_*`; `apply` solo con executor simulado.
- Presupuesto por sesión y techo global; circuit breaker → `REPLAY_ONLY`.
- Resiembra nocturna; sin secretos reales ni egress.
- Uptime monitor sobre `/health`.

## Referencias (leer bajo demanda)

| Necesito... | Sección |
|-------------|---------|
| Jobs y reglas de CI | `playbook/devops.md` → CI |
| Evals en CI | → Evals en CI |
| Imagen y tags | → Contenedores |
| Deploy y rollback | → CD |
| Secretos | → Secretos |
| Expand/contract | → Migraciones |
| Healthchecks y métricas | → Observabilidad |
| Operación y demo | → Operación |
| Checklist de release | `playbook/checklists/release.md` |

## Verificación

```powershell
docker compose config
docker compose ps
curl http://localhost:3000/health
curl http://localhost:3000/health/ready
```
