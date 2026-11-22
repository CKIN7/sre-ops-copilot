# DevOps

> **Tipo:** Guía · **Alcance:** CI, CD, contenedores, secretos, migraciones y
> operación · **Revisión:** 2026-11-15

Prácticas para construir, publicar y desplegar un servicio sin depender del entorno
del desarrollador. El objetivo es un artefacto inmutable por release, un deploy
repetible y un rollback probado.

## Contexto del proyecto

> **Adaptado a sre-ops-copilot.**

- CI: `.github/workflows/ci.yml` — jobs `build`, `test`, `migrations`, `evals`,
  `docker`.
- CD: `.github/workflows/release.yml` — build/push a GHCR y deploy en Fly.io.
- Imagen: `Dockerfile` multi-stage en la raíz; una sola imagen sirve `api`, `worker` y
  `mcp-ops` (cambia el comando).
- Registro: `ghcr.io/<owner>/sre-ops-copilot`, con tags por SHA y por release.
- Local: `docker compose` con `postgres`, `api`, `worker`, `web` y `mcp-ops`.
- Producción: Fly.io, con `api` y `worker` como procesos separados de la misma imagen
  y PostgreSQL gestionado.
- Puertos: API `3000`, MCP `4000`, web `5173` en desarrollo.

---

## Principios

1. **Build once, deploy anywhere:** la misma imagen se valida, publica y despliega.
2. **Tags inmutables:** cada deploy referencia un SHA o una versión, nunca `latest`
   como único identificador.
3. **Configuración por entorno:** todo lo que cambia entre entornos va por variables
   de entorno; nada de secretos en la imagen ni en el repo.
4. **Migraciones compatibles hacia atrás:** la versión anterior debe seguir funcionando
   durante y después del rollout.
5. **Rollback primero:** si no se puede volver atrás en minutos, el deploy no está
   listo.
6. **Mínimo privilegio:** tokens acotados, permisos de workflow explícitos y usuario no
   root en los contenedores.
7. **Los evals son parte del pipeline:** un cambio de prompt o de tool no es
   “documentación”; pasa por el gate.

## CI

Pipeline mínimo, todos obligatorios para `main`:

| Job | Qué valida | Si falla... |
|-----|------------|-------------|
| `build` | `pnpm install --frozen-lockfile` + `typecheck` + `build` | el código no compila |
| `test` | unitarios + integración con PostgreSQL real | hay regresión funcional |
| `migrations` | desde cero y segunda pasada idempotente | el esquema no es reproducible |
| `evals` | golden set sobre fixtures, sin llamadas al modelo | el agente empeoró |
| `docker` | build de la imagen (sin push en PR) | el artefacto no se puede construir |

Reglas:

- Usar `pnpm install --frozen-lockfile`, nunca instalar sin lockfile en CI.
- Fijar versiones: `node-version: 22`, `postgres:16`.
- Levantar dependencias como *services* con healthchecks; no dormir con `sleep`.
- Cachear el store de pnpm y las capas de build (`cache-from/to: type=gha`).
- `permissions:` explícitos y al mínimo (`contents: read`, `packages: write` solo donde
  haga falta).
- `concurrency` para cancelar runs viejos en CI, pero no en release:
  `cancel-in-progress: false` en deploy.
- Timeouts en todos los jobs para no quemar minutos.
- Separar CI de release: CI valida ramas; release publica y despliega.

### Evals en CI

- El job corre contra **fixtures grabadas**: determinista, sin clave de API y sin
  coste por ejecución.
- Falla si `pass@1` cae más de 3 puntos respecto al baseline, si el coste estimado
  supera el 120% del baseline o si hay cualquier violación de invariante.
- Los casos de inyección de prompt son obligatorios: 20/20 bloqueados.
- La suite de contrato contra sandbox real (`kind`) es **nocturna**, no bloquea PRs.

### Contrato sandbox y demo en CI

| Workflow | Cuándo | Qué mide |
|---|---|---|
| `sandbox-contract.yml` | `schedule` 03:00 UTC y `workflow_dispatch` | 6 casos §8.6 contra un cluster `kind` real (`kubectl rollout undo` + readiness) |
| `demo-smoke.yml` | `schedule` 03:30 UTC y `workflow_dispatch` | sesión, techo de steps, breaker y fallback a replay contra Postgres, sin `mcp-ops` |

Reglas:

- Ninguno de los dos va en el gate de PR: el sandbox necesita Docker/kind y el smoke
  necesita Postgres migrado.
- Si Docker/kind no están disponibles, `pnpm contract:sandbox` sale con `1` y el error
  exacto. **Nunca se publica 6/6 sin un run real.**
- La evidencia del contrato se sube como artefacto (`artifacts/`); no se guarda un
  kubeconfig ni credenciales en el repo.
- El caso 6 (flag) se marca como simulado: el `SandboxExecutor` solo cubre rollback.
- `DEMO_MODE=1` exige `EXECUTOR=simulated` y `DEMO_REPLAY_FIXTURES`; el arranque falla
  cerrado si falta cualquiera de los dos.
- Medición local (2026-11-22): `pnpm contract:sandbox` dio **6/6 contra `kind`** (caso 6
  simulado) y `pnpm demo:smoke` quedó verde (`replayOnly`, `writeDenied`, steps
  `1111110`). k6 midió **p95 de run completo exitoso 1.07 s** con 20 VUs; 132/252
  intentos fueron `rate_limited` por el techo de 120 llamadas/min. El benchmark y el
  runbook están en `docs/benchmark.md` y `docs/runbook.md`.

### Protección de `main`

- PR obligatorio.
- Checks `build`, `test`, `migrations` y `evals` obligatorios.
- Merge commits habilitados; squash y rebase deshabilitados.
- No permitir push directo ni force-push.
- Environment `production` con aprobación para el deploy.

## Contenedores

- Imagen **multi-stage**: un stage instala y compila, otro copia solo el artefacto y
  las dependencias de producción.
- Correr como usuario no root (`USER node`).
- `.dockerignore` con `node_modules`, `.git`, tests, logs, `.env` y artefactos de
  `packages/evals/fixtures` que no hagan falta en runtime.
- Copiar solo lo necesario: build compilado, assets estáticos y migraciones.
- `CMD`/`ENTRYPOINT` explícito; un proceso por contenedor.
- Healthcheck en la imagen o en el compose, apuntando a endpoints livianos.
- No instalar herramientas de debug en la imagen de producción.
- Una imagen sirve varios procesos (`api`, `worker`, `mcp-ops`): cambia el comando, no
  la imagen.

### Tags

| Evento | Tags |
|--------|------|
| PR | build, sin push |
| push a `main` | `sha-<full>`, `latest` |
| tag `vX.Y.Z` | `sha-<full>`, `X.Y.Z` |

`latest` es una comodidad, no una referencia de deploy. El deploy usa `sha-<full>` o
`X.Y.Z`.

## CD

Flujo por defecto:

```text
push a main / tag vX.Y.Z
  → job docker: build + push :sha-<full> (+ latest / X.Y.Z)
  → job deploy (environment production)
      login al registro
      migraciones one-shot (release_command)
      flyctl deploy --image ghcr.io/<owner>/sre-ops-copilot:sha-<full>
      readiness check (GET /health/ready) con timeout
```

Reglas:

- El deploy corre después de publicar la imagen, nunca en paralelo.
- Fijar `IMAGE_TAG=sha-<full>` por rollout.
- Aplicar migraciones antes de arrancar la nueva versión, como job one-shot o
  `release_command` de la plataforma.
- Esperar readiness real (PostgreSQL y cola), no solo que el contenedor exista.
- Fallar el job si cualquier paso devuelve código distinto de cero.
- Un environment `production` con aprobación manual y secretos propios.
- Documentar el destino real (Fly.io, Railway, Kubernetes, ECS): este kit asume Fly.io
  y anota el equivalente al adaptarlo.

### Rollback

1. Volver al `IMAGE_TAG` anterior.
2. `flyctl deploy --image ...:sha-<anterior>` (o el equivalente del proveedor).
3. Verificar readiness.
4. Si la migración no es reversible, restaurar backup y documentar el incidente.

El rollback debe probarse al menos una vez por release candidate.

## Secretos

- `.env` nunca se commitea; el repo incluye un `.env.example` sin valores reales.
- En CI/CD, usar secretos del repositorio o del environment, no variables en texto.
- En Fly.io, `flyctl secrets set`; nunca en `fly.toml` ni en la imagen.
- Preferir OIDC o tokens de corta duración sobre PAT permanentes.
- Tokens de registro con el mínimo scope (`read:packages` para pull).
- Rotar credenciales cuando alguien deja el equipo o se sospecha filtración.
- No imprimir secretos en logs; enmascarar `Authorization`, cookies, claves de modelo
  y cuerpos sensibles.
- Separar secretos por entorno (staging ≠ producción).
- `MODEL_API_KEY` solo en el servidor: nunca en el bundle de la web.

## Migraciones

- Versionadas en el repo (`infra/migrations`) y aplicadas por un runner propio versionado
  (ADR-009), no a mano.
- Idempotentes: correrlas dos veces no rompe nada.
- **Expand/contract** para cambios incompatibles:
  1. Agregar columnas/tablas nuevas sin romper la versión actual.
  2. Desplegar código que escribe en ambos formatos o tolera nulos.
  3. Migrar datos en un job separado.
  4. Eliminar lo viejo en un release posterior.
- Nunca hacer `DROP`/`RENAME` en el mismo release que el cambio de código que los usa.
- Probar en CI desde una base vacía y sobre una base con datos representativos.
- En un rollback, la versión anterior debe poder leer el esquema nuevo.

## Observabilidad

- **Liveness:** `GET /health` responde 200 si el proceso está vivo.
- **Readiness:** `GET /health/ready` verifica PostgreSQL y cola; devuelve 503 con
  detalle de qué falló.
- Montar healthchecks **antes** del rate limiter y de la autenticación.
- Logs estructurados (JSON, pino) con nivel, timestamp, request id, `run_id` y
  `tenant_id`; sin datos personales.
- Trazas OpenTelemetry: `run → step → tool_call → action_apply`, con `model`,
  `prompt_version`, `schema_hash` y `executor`.
- Métricas mínimas: latencia, tasa de error, saturación del pool, profundidad de
  colas, reintentos, fallos de jobs y **coste por run**.
- Alertas sobre síntomas del usuario (5xx, readiness caído, cola atascada, coste
  anómalo), no sobre cada métrica.
- Retención de logs definida; los logs dentro del contenedor son efímeros.

## Operación

- **Backups:** dump programado de PostgreSQL y snapshot fuera del host. Probar la
  restauración, no solo el backup.
- **TLS:** en Fly.io es automático; en VPS, Caddy/Nginx delante y `TRUST_PROXY` para
  que el rate limiter use la IP real.
- **Pool de conexiones:** el límite por réplica se multiplica por la cantidad de
  réplicas. Ajustar al límite del servidor.
- **Singletons:** el scheduler de `pg-boss` corre en una sola réplica.
- **Paneles internos:** admin, métricas y visor de evals no se exponen públicamente sin
  autenticación.
- **Cola:** `pg-boss` vive en PostgreSQL; vigilar tamaño de tablas y retención.
- **Demo pública:** `DEMO_MODE` con allowlist reducida, presupuesto por sesión y techo
  global; el circuit breaker conmuta a `REPLAY_ONLY`. Nunca ejecutar escrituras reales
  en la instancia pública.
- **Reset de demo:** resiembra nocturna y botón manual; documentar el job.

## Checklist de release

- [ ] CI verde en `main` y en el PR de release.
- [ ] `pnpm evals` con `pass@1` ≥ baseline y cero violaciones de invariante.
- [ ] Imagen publicada con tag inmutable.
- [ ] Migraciones probadas desde cero y sobre datos existentes.
- [ ] Rollback definido y probado.
- [ ] Secretos y variables del environment revisados.
- [ ] Readiness check pasa después del deploy.
- [ ] Presupuestos y circuit breaker de la demo verificados.
- [ ] Backups recientes.
- [ ] Tag `vX.Y.Z` creado.

## Adaptación a otro proyecto

- Reemplazar GHCR por el registro real (ECR, GCR, Docker Hub) y ajustar permisos.
- Cambiar Fly.io por el destino real (Kubernetes, ECS, VM, PaaS) y ajustar el comando
  de deploy.
- Si no hay Docker, conservar los principios: artefacto inmutable, config por entorno,
  migraciones compatibles y rollback.
- Ajustar los servicios de CI al motor de base de datos y cache del proyecto.
- Si el proyecto es serverless, reemplazar readiness por smoke tests post-deploy y
  versionado de funciones.
