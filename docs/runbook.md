# Runbook de operacion e incidente

> Alcance: Beacon sobre el stack sembrado. Este runbook es del propio copiloto
> (API, gateway, orquestador, `mcp-ops`, executors y demo), no de los servicios
> sembrados. Para el procedimiento de un servicio concreto se usa
> `search_runbooks` o la tabla `runbooks` del seed.

## 1. Antes de empezar

Requisitos: Node 22, `pnpm`, Docker, Postgres 16 y, para el sandbox, `kind` y
`kubectl`. El `.env` local es la referencia de puertos y tokens; no se copia al
repo ni se pega en logs.

```powershell
pnpm install --frozen-lockfile
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --wait
pnpm db:migrate
$env:SEED_SCALE="0.1"; pnpm db:seed
```

El seed debe ser reciente: las tools usan ventanas relativas a `now()`. Si el
dashboard o los evals ven datos vacios, re-siembra antes de investigar.

Comprobaciones minimas:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3000/health
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:4000/mcp
pnpm evals:gate
```

`/health` debe devolver `200`; `mcp-ops` responde `405` a un `GET` sin sesion
MCP, que es lo esperado en Streamable HTTP.

## 2. Arranque de los servicios

Cuatro terminales:

```powershell
# 1. MCP por Streamable HTTP (tools de lectura y propuestas)
pnpm --filter @beacon/mcp-ops start:http

# 2. API Fastify
pnpm start:api

# 3. CLI para investigar
pnpm cli run --goal "Investiga el pico de errores 5xx en checkout"

# 4. UI (proxy de Vite con el bearer del .env)
pnpm --filter @beacon/web dev
```

La UI habla solo con la API por `/api`. No lee Postgres ni llama a `mcp-ops`.

## 3. Flujo de incidente

1. **Detectar.** Una alerta, el dashboard o una persona reporta el sintoma. No se
   actua por una hipotesis sin evidencia.
2. **Investigar.** Lanzar un run con un objetivo acotado. El orquestador encadena
   `query_metrics`, `get_deploys`, `search_logs`, `get_trace_summary` y
   `search_runbooks` segun el modelo guionizado.
3. **Leer la timeline.** Revisar steps, tool calls, latencias, coste y la
   evidencia citada. El run no escribe nada por si solo.
4. **Proponer.** Para una escritura, el agente (o una persona) llama a
   `propose_rollback`, `propose_set_flag` o `propose_silence_alert`. La tool solo
   calcula el plan y el gateway lo persiste como propuesta con su `approval_id`.
5. **Aprobar o rechazar.** Una persona revisa diff, radio de impacto y evidencia.
   Sin decision humana no hay `apply`. El motivo queda en la auditoria.
6. **Aplicar y verificar.** El `apply` es idempotente ante reintento y comprueba
   la post-condicion. Los estados posibles son `applied`, `noop`, `conflict`,
   `timeout`, `degraded`, `partial` y `failed`.
7. **Cerrar.** Registrar el resultado, la evidencia y las acciones de mejora. Si
   el efecto no se verifico, el estado es `degraded`, no exito.

Nunca se salta el gateway ni se llama a una tool fuera de la allowlist. El
`tenant_id` y el `user_id` salen del servidor, nunca del modelo.

## 4. Escrituras en dos fases

```powershell
# 1. Proponer
curl.exe -X POST http://127.0.0.1:3000/proposals `
  -H "authorization: Bearer $env:BEACON_TOKEN" `
  -H "content-type: application/json" `
  -d '{"tool":"propose_rollback","args":{"service":"checkout","to_version":"1.41.0","reason":"pico de 5xx"}}'

# 2. Aprobar: esta llamada ejecuta el apply
curl.exe -X POST http://127.0.0.1:3000/proposals/<proposal_id>/approve `
  -H "authorization: Bearer $env:BEACON_TOKEN" `
  -H "content-type: application/json" `
  -d '{"reason":"el pico es real; adelante"}'
```

La aprobacion ejecuta el `apply` en la misma llamada de la API. La reanudacion
del run tras la aprobacion sigue pendiente (ver `docs/plan.md`).

## 5. Modos de ejecucion

| Modo | Configuracion | Que hace |
|---|---|---|
| Simulado | `EXECUTOR=simulated` | Muta estado versionado en Postgres; determinista |
| Sandbox | `EXECUTOR=sandbox`, `SANDBOX_TARGET=kind` | `kubectl rollout undo` real y readiness con timeout |
| Demo | `DEMO_MODE=1`, `EXECUTOR=simulated` | Sesion anonima, techos, breaker y replay; nunca escribe de verdad |
| Replay | `REPLAY_ONLY=1` | Transporte de fixtures; deniega `propose_*` |

`SANDBOX_TARGET=compose` falla cerrado: no hay adaptador medido. El caso 6 del
contrato (flag) es simulado porque el sandbox solo cubre rollback.

## 6. Fallos comunes

| Sintoma | Comprobacion | Accion |
|---|---|---|
| `ECONNREFUSED` en 5433 | `docker compose ps` | Levantar Postgres y aplicar migraciones |
| Tools sin datos | ventana relativa a `now()` | Re-sembrar con `SEED_SCALE=0.1` |
| `rate_limited` | `RATE_LIMIT_TOOL` / `RATE_LIMIT_TENANT` | Bajar concurrencia o subir el techo de forma explicita; no desactivar el rate limit |
| Presupuesto agotado | `budget_reservations` / `usage_ledger` | Revisar `BUDGET_*`; no borrar el ledger |
| `REPLAY_ONLY` activo | health de la API y breaker | Esperar recuperacion o reiniciar el breaker con criterio |
| `conflict` en rollback | historial de ReplicaSets | Reconciliar y esperar; no reintentar a ciegas |
| Readiness no verificada | estado observado del deployment | Tratar como `degraded`; no declarar exito |
| `kubectl cluster-info` falla | `kind get clusters` | `./infra/kind/bootstrap.sh` |

No se rodea un fallo con mocks para declarar verde. Si falta el entorno, se
documenta el blocker con el error exacto.

## 7. Evidencia y auditoria

- Timeline: `GET /runs/:id` (o la UI) con steps, tool calls y estados.
- Auditoria encadenada: `pnpm cli audit verify`.
- Propuestas y aprobaciones: `proposals` y `approvals` en Postgres.
- Contrato sandbox: `pnpm contract:sandbox` escribe evidencia en `artifacts/`.
- Demo: `pnpm demo:smoke` comprueba techo de steps, breaker, replay y denegacion
  de escrituras sin llamar a `mcp-ops`.
- Carga: `infra/k6/run-api.js` mide runs completos exitosos. No hay cola, por lo
  que no se publica un p95 de encolado.

Para inspeccionar sin modificar estado:

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.yml exec -T postgres `
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select id,status,goal,started_at,ended_at from runs order by created_at desc limit 5;"'
```

## 8. Simulacro de incidente

El simulacro reproducible esta descrito en
`docs/postmortem-2026-11-22-checkout-5xx.md`:

1. Confirmar el seed y el deploy `checkout` `1.42.0`.
2. Lanzar el run de investigacion con el objetivo del pico de 5xx.
3. Leer la timeline y citar la metrica y el deploy correlacionado.
4. Seguir el runbook de rollback y pasar por propuesta y aprobacion.
5. Verificar la post-condicion y registrar el resultado.
6. Anotar que el incidente y los datos son sinteticos.

## 9. Limpieza

```powershell
./infra/kind/teardown.sh
docker compose --env-file .env -f infra/compose/docker-compose.yml down
```

No se borra el `usage_ledger` ni la auditoria para "limpiar" una demo.
