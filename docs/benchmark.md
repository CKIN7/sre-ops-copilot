# Benchmark reproducible

> Todos los numeros de esta pagina se midieron en local el **2026-11-22** con el
> stack sembrado. No hay LLM ni proveedor: el modelo es guionizado y el coste de
> proveedor es 0 centimos. No hay cola, asi que no existe un p95 de encolado.

## Entorno

- Windows, Node 22, `pnpm` 12, Docker con Postgres 16.
- `DATABASE_URL` apunta al Postgres de `infra/compose` (puerto 5433 en el `.env`).
- `SEED_SCALE=0.1`: 6 servicios, 311040 puntos de metrica, 200000 logs, 40 deploys.
- `mcp-ops` por Streamable HTTP en `:4000`; API en `:3000`.

## Como reproducir

```powershell
pnpm install --frozen-lockfile
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --wait
pnpm db:migrate
$env:SEED_SCALE="0.1"; pnpm db:seed

# Terminal 1: MCP
pnpm --filter @beacon/mcp-ops start:http

# Terminal 2: API
pnpm start:api

# Evals, presupuesto y contrato
pnpm evals:gate
pnpm evals:meta
pnpm budget:concurrency
./infra/kind/bootstrap.sh
$env:SANDBOX_TARGET="kind"; $env:SANDBOX_NAMESPACE="beacon-sandbox"; $env:READINESS_TIMEOUT="10s"
pnpm contract:sandbox

# Carga (el token sale del .env; no se imprime)
$line = Get-Content .env | Where-Object { $_ -match '^BEACON_TOKEN=' } | Select-Object -First 1
$env:BEACON_TOKEN = $line.Substring('BEACON_TOKEN='.Length).Trim().Trim('"')
k6 run -e BEACON_TOKEN=$env:BEACON_TOKEN -e VUS=20 -e DURATION=10s infra/k6/run-api.js
```

## Resultados

### Evals

Medido con `pnpm evals:gate` sobre las fixtures versionadas:

| Metrica | Valor |
|---|---|
| Casos | 60/60 |
| `pass@1` | 100% |
| `pass@5` | 100% (modelo determinista) |
| Precision de seleccion de tool | 100% |
| Tools inventadas | 0% |
| False-action rate | 0% |
| Fault-handling | 5/5 |
| Red-team bloqueado | 20/20 |
| Violaciones de invariante | 0 |
| Coste medio por run | 0 centimos |
| p95 del harness in-process | 4 ms |

`pnpm evals:meta` muta `query_metrics` y lleva `pass@1` a 0% (60/60 casos); la
mutacion neutra de `get_oncall` sigue en 100%.

### Presupuesto

`pnpm budget:concurrency` con 20 reservas concurrentes:

| Metrica | Valor |
|---|---|
| Runs | 20 |
| Permitidos / denegados | 10 / 10 |
| Liquidado | 10 centimos |
| Reservas abiertas | 0 |
| Filas de ledger | 10 |
| `budgetRespected` | `true` |
| Duracion | 157 ms |

### Contrato sandbox

`pnpm contract:sandbox` contra `kind` real:

| Caso | Resultado |
|---|---|
| 1. rollback aplicado y readiness OK | ok (real) |
| 2. version inexistente -> `conflict` | ok (real) |
| 3. misma key no reejecuta | ok (real) |
| 4. timeout de readiness no es exito | ok (real) |
| 5. rollout en curso -> `conflict` reconciliable | ok (real) |
| 6. flag aplicada y revertida | ok (simulado) |

Total: **6/6** en 59 s. Evidencia versionada en
`docs/evidence/sandbox-contract-2026-11-22T02-14-11.527Z.json`.

### Carga

Corrida: 20 VUs durante 10 s, objetivo
`Investiga el pico de errores 5xx en checkout`.

| Metrica | Valor |
|---|---|
| Iteraciones | 252 |
| Peticiones HTTP | 504 |
| Errores HTTP | 0% |
| Runs `succeeded` | 120 |
| Runs `rate_limited` | 132 |
| p95 de run completo (solo `succeeded`) | **1.07 s** |
| Mediana de run completo | 0.56 s |
| p95 de runs fallidos (rate limit) | 0.07 s |

**Por que se separa:** a 20 VUs se supera `RATE_LIMIT_TOOL=120` por minuto. Los
132 runs denegados no son runs completos: su latencia no debe entrar en el p95
de run completo. El escenario `infra/k6/run-api.js` solo suma a
`run_complete_ms` los runs `succeeded` y reporta `run_succeeded` por separado.
Para una corrida sin saturacion, usar `-e VUS=8`.

Comprobacion de solo lectura sobre Postgres:

```sql
select status, count(*) as runs,
       round(percentile_cont(0.95) within group (
         order by extract(epoch from (ended_at - started_at)) * 1000)::numeric, 1) as p95_ms
from runs
where created_at >= now() - interval '30 minutes'
group by status;
```

## Límites conocidos

- Incidente y datos **sinteticos**; no hay produccion real.
- Modelo guionizado: el comportamiento es determinista y no mide calidad de un LLM.
- El sandbox solo cubre `rollback`; el caso 6 (flag) es simulado.
- No hay cola: no se publica p95 de encolado.
- A 20 VUs el rate limit por tool satura; es gobierno funcionando, no una averia.
