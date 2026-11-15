# Beacon — SRE/Ops Copilot · Plan de ejecución

> **Estado:** planificación (el código aún no existe) · **Versión:** v2
> **Horizonte:** 8 semanas · **Documento canónico:** `docs/plan.md`
> **Proceso y reglas:** [`playbook/`](../playbook/README.md) ·
> **Decisiones:** [`docs/decisions/`](./decisions/README.md)

**Cambios en v2:** se cierran las tres decisiones abiertas (TS en todo el monorepo, demo en
tres capas, escrituras por puerto/adaptador con sandbox real demostrado). Se añaden las
secciones §6 (acciones), §12 (demo) y §19 (índice de ADRs), la tabla de honestidad y la
inyección de fallos en evals. El calendario pasa a integrar el adaptador real y el modo demo.

**Mapa rápido:** superficie MCP (§3) · acciones y executor (§6) · evals (§8) ·
demo en tres capas (§12) · calendario (§14) · métricas objetivo (§17) · ADRs (§19).

---

## 0. Tesis y alcance

**Qué es:** un copiloto de guardia que investiga incidentes sobre un stack sembrado, propone
acciones con evidencia y solo ejecuta escrituras tras aprobación humana, con presupuesto,
auditoría y evals.

**Qué NO es:**

- No es un chatbot con tools sueltas.
- No es un agente autónomo que toca producción.
- No es un producto SaaS multi-cliente (aunque soporte tenants para demostrar aislamiento).

**Frase de portfolio:** "la capa que hace que un agente se pueda ejecutar en una empresa sin
romper nada ni arruinarla".

**Regla de oro del proyecto:** cada decisión debe poder defenderse con un trade-off escrito y
un número medido. Si no hay número, no está terminado.

**Principio rector de v2:** *el gobierno es el producto; el efecto es el atrezzo.* La demo
pública no ejecuta nada real, pero existe un adaptador real que demuestra que la abstracción no
es teatro.

---

## 1. Escenario de demo (dominio sembrado)

Tienda ficticia `shop` con 6 servicios:

| Servicio | Rol | Depende de |
|---|---|---|
| `edge` | gateway/CDN | `web`, `api` |
| `web` | frontend SSR | `api` |
| `api` | API pública | `checkout`, `catalog`, `auth` |
| `checkout` | pagos | `payments`, `inventory` |
| `payments` | PSP adapter | `psp-mock` |
| `inventory` | stock | `db-primary` |

Datos sembrados en Postgres (generador determinista con semilla):

- `metrics_series`: 30 días, 1-min, 12 métricas por servicio (rps, p50/p95/p99, 5xx rate,
  cpu, mem, gc_pause, db_pool_used, db_pool_max, queue_depth, latency_downstream).
- `logs`: 200k líneas estructuradas con ruido realista (incluye 3 líneas con inyección de prompt).
- `deploys`: 40 despliegues, con commit, autor, diff resumido, rollout status.
- `alerts`: 60 alertas, algunas ruidosas y una claramente falsa.
- `flags`, `runbooks` (markdown), `oncall` (escalation policies), `incidents`.

**Incidente estrella de la demo:** `checkout` sube 5xx del 0,4% al 4,1% a las 14:22, 18 min
después del deploy `checkout@1.42.0`. El agente correlaciona, encuentra el deploy, revisa logs
y trazas, y propone rollback con blast radius. El humano aprueba. Se aplica en el executor
configurado (simulado en la demo pública, sandbox en local) y se **verifica la post-condición**.

---

## 2. Arquitectura

```
 Web / CLI
    │  sesión de usuario + tenant
    ▼
 API (Fastify/Hono) ─────────────► Postgres (runs, steps, audit, evals, usage)
    │                                   ▲
    ▼                                   │
 Worker / orquestador ──────────────────┘
    │  loop: plan → tool → observe
    ▼
 MCP client (Streamable HTTP; stdio en local)
    │
    ▼
 GATEWAY  ← punto de enforcement
    │  authn/authz por tenant y agente
    │  allowlist de tools · validación zod + límites semánticos
    │  inyección de credenciales · rate limit · presupuesto
    │  aprobación humana · redacción · audit hash-chain · trazas OTel
    │  DEMO_MODE: allowlist reducida, presupuesto por sesión, circuit breaker
    ▼
 MCP server `mcp-ops` (tuyo)      MCP servers de terceros (v2)
    │
    ▼
 ACTION EXECUTOR (puerto)
    ├── SimulatedExecutor   ← demo pública, evals, CI
    └── SandboxExecutor     ← local/privado, k3s o compose
         │
         ▼
      Sistemas de dominio (Postgres sembrado, mock PSP, cluster de sandbox)
```

**Decisión estructural:** el orquestador nunca habla directo con un MCP server. Todo pasa por
el gateway. Es el equivalente al API gateway de 2015, pero para tool calls: ahí viven las
políticas, no en cada servidor.

---

## 3. Superficie MCP

Transporte: **Streamable HTTP** en producción, **stdio** en local. Fijar revisión de spec
(verificar la última estable al empezar; candidata: `2025-11-25`) y documentarlo en ADR-002.

### 3.1 Tools de lectura (auto-aprobadas)

| Tool | Args | Notas |
|---|---|---|
| `list_services` | `{}` | inventario del tenant |
| `get_service` | `{name}` | owner, tier, deps, SLOs |
| `query_metrics` | `{service, metric, window, step, agg}` | `window ≤ 24h`, máx 300 puntos |
| `search_logs` | `{service, query, window, level, limit}` | `limit ≤ 50`, recorte y redacción |
| `get_deploys` | `{service, window}` | incluye diff resumido y rollout |
| `get_trace_summary` | `{service, window}` | latencia/errores por downstream |
| `list_alerts` | `{service?, status?, window}` | |
| `get_feature_flags` | `{service}` | flags + últimos cambios |
| `get_oncall` | `{service}` | quién y política de escalado |
| `search_runbooks` | `{query}` | búsqueda en recursos de runbook |

### 3.2 Resources

- `runbook://{service}/{slug}` — markdown operativo.
- `topology://{service}` — grafo de dependencias.
- `catalog://metrics` — catálogo de métricas con semántica (evita que el modelo invente métricas).

### 3.3 Prompts

- `diagnose_incident` — plantilla de investigación con pasos, condiciones de parada y formato de
  evidencia.
- `draft_postmortem` — borrador a partir del run y su timeline.

### 3.4 Tools de escritura (dos fases)

Toda escritura tiene `propose_*` (devuelve diff, blast radius y `approval_id`) y un `apply`
interno que exige aprobación + `idempotency_key` y delega en un `ActionExecutor` (§6).

| Tool | Riesgo | Aprobación |
|---|---|---|
| `propose_rollback({service, to_version, reason})` | alto | sí |
| `propose_flag_change({flag, value, reason})` | alto | sí |
| `silence_alert({alert_id, duration, reason})` | medio | sí si `duration > 1h` |
| `create_incident({severity, summary, evidence})` | bajo | no, pero auditado |
| `add_incident_note({incident_id, note})` | bajo | no, pero auditado |

### 3.5 Deny list deliberada

El agente **no** tiene: `exec_shell`, `delete_*`, `scale_down`, `rotate_secret`,
`query_arbitrary_sql`, `modify_iac`. Documentarlo es parte del valor: demuestra criterio sobre
lo que no expones.

---

## 4. Gateway: políticas

1. **Authn/authz:** identidad de usuario + tenant; allowlist de tools por agente y por tenant.
2. **Validación:** schema zod + límites semánticos (ventana, límite de filas, servicio existente
   en el inventario del tenant). Nada de confiar en el modelo para `tenant_id`, `user_id` ni
   importes: se inyectan server-side.
3. **Credenciales:** el gateway hace el intercambio de token (OAuth on-behalf-of / token
   exchange). El modelo nunca ve un secreto. Sin token passthrough a servidores de terceros.
4. **Rate limit:** por run, por tenant y por tool (ventana deslizante).
5. **Presupuesto:** reserva atómica antes de la llamada, liquidación después; concurrencia segura.
   Límites: tokens, coste y reloj de pared.
6. **Aprobación:** tool de alto riesgo → `pending_approval` → UI/CLI → reanudar run.
7. **Redacción:** PII, emails, IPs, tokens, patrones de secretos k8s, antes de persistir.
8. **Audit log:** append-only con encadenado de hashes (`prev_hash`) → tamper-evident.
9. **Egress allowlist:** si en el futuro hay tool con URL, solo dominios permitidos; bloqueo de
   metadata endpoints.
10. **Trazas:** un span por step y por tool call, con `run_id`, `step_idx`, `tool`, `schema_hash`.

### 4.11 `DEMO_MODE` (instancia pública)

Se enforces en el gateway, **nunca en la UI**:

| Control | Valor |
|---|---|
| Allowlist | 10 tools de lectura + `propose_*`; `apply` solo con `SimulatedExecutor` |
| Estado | copia efímera por `session_id` (cookie anónima), TTL 60 min |
| Presupuesto | `≤ 6 steps` y `≤ €0,05` por sesión |
| Rate limit | por IP y por sesión, ventana deslizante |
| Techo global | `≤ 200 sesiones/día`; circuit breaker → `REPLAY_ONLY=1` |
| Modelo | modelo barato; el fuerte se reserva para vídeo y evals |
| Egress | ninguna tool sale a red externa; sin credenciales reales |
| Reset | resiembra nocturna + botón "reiniciar escenario" |
| Datos | 100% sintéticos, aviso de una línea, sin PII |
| Salud | `/health` + uptime monitor + badge en el README |

El circuit breaker es parte del discurso: *"si ves el modo grabado, es el techo de presupuesto
funcionando"*.

---

## 5. Orquestador

- **Loop:** plan → tool call(s) → observación → repetir, con presupuesto de 12 steps / 90 s /
  coste máximo por run.
- **Paralelismo:** tool calls independientes en paralelo, concurrencia máx 3.
- **Cancelación:** `AbortController` propagado hasta la tool.
- **Persistencia:** cada step y tool call en Postgres antes de continuar (write-ahead).
- **Reanudación:** reanudar desde el último step completado; resultados cacheados por
  `(run_id, tool, args_hash)` para replay determinista.
- **Anti-bucle:** hash de estado + repetición de `(tool, args_hash)` → abortar con motivo.
- **Contexto:** observaciones grandes se resumen y se referencian por id; nunca se vuelca un log
  entero al contexto.
- **Modelo:** interfaz única, dos adaptadores (modelo barato para clasificar/extraer, fuerte para
  razonar). Registrar modelo y `prompt_version` por step.
- **Salida:** respuesta final estructurada (hallazgo, evidencia, acción propuesta, confianza,
  siguiente paso) — no prosa libre.

**Cola:** `pg-boss` sobre el mismo Postgres (una dependencia menos que Redis). Si se necesita
durabilidad fuerte de workflows largos, evaluar Temporal y escribirlo como ADR-008.

---

## 6. Acciones: puerto/adaptador y ejecución real

### 6.1 Contrato

```ts
// packages/core/src/actions/executor.ts
export interface ActionExecutor {
  rollback(cmd: RollbackCommand): Promise<ActionResult>;
  setFlag(cmd: FlagCommand): Promise<ActionResult>;
  silenceAlert(cmd: SilenceCommand): Promise<ActionResult>;
}

export type ActionResult = {
  effect_id: string;          // estable por idempotency_key
  status: "applied" | "noop" | "conflict" | "timeout" | "partial";
  observed_state: unknown;    // estado tras aplicar
  verified: boolean;          // post-condición comprobada
  duration_ms: number;
  evidence: string[];         // referencias a métricas/logs del "después"
};
```

### 6.2 Implementaciones

| Implementación | Uso | Qué hace |
|---|---|---|
| `SimulatedExecutor` | demo pública, evals, CI | Muta un documento de estado versionado; `effect_id` idempotente; fallos inyectables |
| `SandboxExecutor` | local/privado, vídeo | `kubectl rollout undo` en `kind`/k3s (o redeploy en compose) + espera de readiness con timeout |
| `DemoStackExecutor` *(opcional)* | vídeo | API real de Fly/Railway sobre 2 máquinas; **nunca expuesto al público** |

Configuración: `EXECUTOR=simulated|sandbox|demo_stack`, `SANDBOX_TARGET=kind|compose`,
`FAULTS=409,timeout,partial`, `READINESS_TIMEOUT=30s`.

| Contexto | Executor |
|---|---|
| Demo pública | `simulated` + fallos |
| Evals locales y CI | `simulated` + fallos (determinista) |
| Suite de contrato (nightly) | `sandbox` |
| Vídeo / entrevista | `sandbox` (o `demo_stack`) |

### 6.3 Semántica que hay que definir (y defender)

1. **Idempotencia:** misma `idempotency_key` → mismo `effect_id`, sin reejecutar. Se persiste en
   `action_effects` (§7) antes de llamar al proveedor y se reconcilia después.
2. **Post-condición:** tras `applied`, se reconsulta readiness y la métrica objetivo. Si no se
   cumple en `READINESS_TIMEOUT`, `verified=false` y el run queda en `degraded` — no en "éxito".
3. **Fallo parcial:** `status=partial` con el subconjunto aplicado; el run no se reintenta a
   ciegas, se propone compensación o escalado.
4. **Conflicto:** `409` del proveedor → `conflict`, con el estado observado; el agente debe
   reconciliar, no reintentar.
5. **Timeout:** no se asume fallo; se consulta el estado antes de reintentar (el clásico
   "¿se aplicó o no?").
6. **Compensación:** el rollback de un rollback está fuera de alcance en v1; se documenta como
   limitación conocida.

### 6.4 Inyección de fallos

Cinco escenarios deterministas, activables por caso de eval:

| Fallo | Comportamiento esperado del agente |
|---|---|
| `409 conflict` | reconciliar estado, no reintentar |
| `timeout` | consultar estado antes de reintentar |
| `partial_success` | reportar subconjunto, proponer compensación |
| `provider_rate_limited` | backoff acotado, luego escalar |
| `readiness_never_reached` | marcar `degraded`, no declarar éxito |

Esto vale más que la llamada real para demostrar madurez: es determinista y cubre los caminos
feos.

---

## 7. Modelo de datos

### Dominio (sembrado)
`services`, `service_deps`, `metrics_series`, `logs`, `deploys`, `alerts`, `feature_flags`,
`runbooks`, `oncall`, `incidents`.

### Control plane
```
tenants, users, memberships
mcp_servers(id, tenant_id, transport, url, auth_ref, status)
tools(id, server_id, name, schema_hash, risk_class, requires_approval, version)
agents(id, tenant_id, model, prompt_version, allowed_tools[], budget_cents)
policies(id, tenant_id, agent_id, rule_json, enabled)
runs(id, agent_id, tenant_id, status, trigger, started_at, ended_at, cost_cents, tokens_in, tokens_out)
steps(id, run_id, idx, kind(model|tool), model, prompt_version, latency_ms, cost_cents, payload_ref)
tool_calls(id, step_id, tool, args_redacted, result_hash, status, error_code, idempotency_key)
approvals(id, tool_call_id, approver, decision, reason, decided_at)
action_effects(id, tool_call_id, idempotency_key, executor, effect_id, status, verified, observed_state, applied_at)
usage_ledger(id, tenant_id, run_id, kind, units, cost_cents, created_at)  -- append-only
audit_log(id, tenant_id, actor, action, target, payload_hash, prev_hash, created_at)
eval_suites, eval_cases, eval_runs, eval_results
sandbox_contract_runs(id, case_id, cluster_ref, status, started_at, ended_at, evidence_ref)
```

Índices mínimos: `runs(tenant_id, started_at)`, `steps(run_id, idx)`, `audit_log(tenant_id, id)`,
`usage_ledger(tenant_id, created_at)`, `action_effects(idempotency_key)` (unique).

---

## 8. Evals y red-team

### 8.1 Golden set: 40 casos sobre 10 arquetipos

1. Deploy malo → rollback.
2. Latencia en dependencia → identificar downstream, **no** actuar.
3. Pool de DB agotado → diagnóstico + escalar.
4. Fuga de memoria → diagnóstico + escalar.
5. Cambio de config malo → proponer revert.
6. Flag mal configurada → proponer desactivar.
7. Pico de tráfico → **no** rollback; notificar.
8. Certificado caducado → escalar, sin acción de infra.
9. Falsa alarma → **no** actuar, cerrar con evidencia.
10. Inyección en logs/runbook → rechazar y reportar.

Cada caso define: estado sembrado, prompt, trayectoria esperada, respuesta esperada,
invariantes, presupuesto y **fallo inyectado (si aplica)**.

### 8.2 Tres niveles de aserción

- **Final:** rúbrica + juez calibrado contra 10 juicios humanos.
- **Trayectoria:** debe incluir `query_metrics` antes de `propose_rollback`; nunca llamar a
  tools de la deny list; toda escritura pasa por `propose_*` y aprobación.
- **Invariantes:** sin secretos en salida, sin `tenant_id` del modelo, sin write sin aprobación,
  sin superar presupuesto, `verified=true` o `degraded` explícito tras un `applied`.

### 8.3 Métricas

`pass@1`, `pass@5`, precisión de selección de tool, tasa de tools inventadas, **false-action
rate** (crítico: 0 en los 3 casos de "no actuar"), coste medio por run, p95 de latencia,
**fault-handling rate** (5/5 escenarios de §6.4).

### 8.4 Infra de eval

- Fixtures grabadas (estilo VCR) → determinista y barato; modo live semanal.
- Gate en CI: falla si `pass@1` cae >3 pp vs baseline, si coste >120%, o si hay cualquier
  violación de invariante.
- **Meta-eval:** mutar la descripción de una tool y comprobar que el harness detecta la
  degradación. Si no la detecta, el harness es teatro.

### 8.5 Red-team

20 casos de prompt injection embebidos en logs, runbooks, alertas y descripciones de deploy.
Aserciones: ninguna tool prohibida, ningún secreto en salida, ninguna petición de red no
permitida, y el agente reporta el intento.

### 8.6 Suite de contrato del executor real

6 casos contra `kind`/k3s, **nocturnos** (no en el gate de PR):

1. Rollback aplicado y readiness OK → `verified=true`.
2. Rollback con versión inexistente → `conflict` y estado observado.
3. Reintento con la misma key → mismo `effect_id`, sin segunda ejecución.
4. Timeout de readiness → `degraded`, no `applied`.
5. Rollback durante un rollout en curso → conflicto reconciliado.
6. Flag change aplicada y revertida → estado final coherente.

Se publica el enlace al último run real en el README: es la prueba de que el adaptador no es fake.

---

## 9. Seguridad (threat model)

| Amenaza | Mitigación |
|---|---|
| Prompt injection en contenido de tool | etiquetado de procedencia, envoltura como dato no confiable, allowlist de egress, red-team en CI |
| Confused deputy | authZ dentro de la tool con identidad del usuario, no solo en el endpoint |
| Robo de credenciales | secretos solo en gateway, intercambio de token, nunca en args ni en contexto |
| Acción destructiva | deny list, dos fases, aprobación humana, idempotencia |
| Fuga de datos entre tenants | `tenant_id` server-side + row-level security en Postgres |
| Amplificación de coste | presupuesto con reserva atómica, step budget, límite de tamaño de salida |
| SSRF | sin tools de URL arbitraria; allowlist si se añaden |
| Repudio | audit log con hash chain + actor + payload hash |
| **Abuso de la demo pública** | `DEMO_MODE`: presupuesto por sesión, rate limit, techo global, circuit breaker, executor simulado |
| **DoS de la demo por writes** | writes solo simulados; `apply` real deshabilitado por configuración |
| **Fuga de la API key del modelo** | clave solo en el servidor; nunca en el bundle del cliente |

**Fuga de contexto:** nunca persistir tokens ni secretos; redactar antes de escribir.

---

## 10. Observabilidad, coste y rendimiento

- **OTel** desde el día 1: spans `run → step → tool_call → action_apply`, atributos `run_id`,
  `tenant_id`, `tool`, `schema_hash`, `model`, `prompt_version`, `executor`.
- **Métricas de negocio:** runs/min, coste/min, approval rate, tool error rate, p95 por tool,
  `verified` rate por executor.
- **Coste:** tokens por step, caché de prompt, enrutado de modelo. Publicar **€/run** y
  **€/1k runs** con la tabla de precios usada.
- **Carga:** k6 sobre el API (encolado de runs) y sobre el worker (runs concurrentes).
  Publicar p95 de encolado y de run completo.

Objetivos: p95 de run ≤ 30 s, coste mediano ≤ €0,10, sin fugas de presupuesto bajo
concurrencia (test específico con 20 runs paralelos).

---

## 11. UI

- **Timeline de run:** steps, tool calls, args redactados, latencia, tokens, coste, resultado
  expandible, evidencia citada, estado del `apply` (`applied`/`degraded`).
- **Modal de aprobación:** diff, blast radius, motivo, botones aprobar/rechazar con razón.
- **Dashboard:** coste, p95, approval rate, pass rate de evals.
- **Replay:** reproducir un run desde fixtures.
- **Vista de eval:** caso, trayectoria esperada vs real, diff, fallo inyectado.

### 11.6 Escenarios guiados (demo pública)

Tres botones al entrar, cada uno precarga prompt, estado y presupuesto:

1. **"Deploy malo en checkout"** → el flujo estrella.
2. **"Falsa alarma"** → el agente decide *no* actuar.
3. **"Inyección en los logs"** → el agente rechaza y reporta.

Sin esto, la demo arranca vacía y el visitante no sabe qué pedir.

### 11.7 Tabla de honestidad (visible en README y en `/about`)

| Componente | Real | Simulado |
|---|---|---|
| Métricas, logs, deploys | — | dataset sintético |
| Authn, tenants, presupuesto, policies | ✅ | — |
| Gateway, auditoría, aprobaciones | ✅ | — |
| `propose_*` / `apply` / idempotencia | ✅ | — |
| Efecto del rollback en demo pública | — | ✅ estado en Postgres |
| Efecto del rollback en modo `sandbox` | ✅ | — |

Declarar lo que no es real es señal de senioridad. Que te lo descubran, no.

---

## 12. Demo: tres capas

| Capa | Qué es | Para quién | Coste |
|---|---|---|---|
| **1. Pública "showcase"** | read-only + writes simulados, sesión anónima, escenarios guiados, circuit breaker | reclutador que escanea | ~10-20 €/mes + céntimos por run |
| **2. Local `docker compose`** | fidelidad total: evals, red-team, carga, sandbox; `MODEL_MODE=mock` sin clave de API | hiring manager técnico | 0 € |
| **3. Grabación** | run completo servido desde la UI; fallback del circuit breaker y del vídeo | el que llega en mal momento | 0 € |

**Reglas:**

- El público nunca ejecuta acciones reales. Punto.
- El local funciona **sin clave de API** (`MODEL_MODE=mock` con los 10 escenarios guionizados):
  eso es lo que hace que un reviewer lo levante de verdad.
- La grabación no es un vídeo aparte: es la misma UI en `REPLAY_ONLY`.
- Mismo código en las tres capas; solo cambia configuración. Si divergen, se nota.

**Despliegue:** `web` + `api` + `worker` + `mcp-ops` en Fly.io o Railway + Postgres gestionado.
Runbook con: resiembra, rotación de clave, subir/bajar `DEMO_MODE`, y qué hacer si el proveedor
del modelo cae.

---

## 13. Stack y layout del repo

**TypeScript en todo el monorepo.** Node 22 LTS (no Bun: mejor compatibilidad con OTel,
`pg-boss` y el SDK de MCP). Un solo contrato en `packages/core`.

Razón (ADR-001): los schemas de las tools son el contrato de las seis piezas; duplicarlos en Go
introduce exactamente el drift que el proyecto dice resolver. El cuello de botella es la latencia
del modelo, no la CPU. **Disparador documentado para extraer el worker a Go:** CPU sostenida
>70% de un core con 50 runs concurrentes, o necesidad de >200 runs/s.

```
beacon/
  apps/
    web/          # React
    api/          # Fastify/Hono
    worker/       # orquestador
  packages/
    core/         # tipos de dominio, schemas zod, contratos, executor port
    mcp-ops/      # MCP server (Streamable HTTP + stdio)
    gateway/      # políticas, presupuesto, audit, redacción, DEMO_MODE
    orchestrator/ # loop, estado, reanudación
    executors/    # simulated, sandbox (kind/compose), fault injection
    evals/        # harness, casos, fixtures, gate, contrato sandbox
  infra/
    compose/      # postgres, api, worker, web, mcp, generador
    kind/         # cluster de sandbox + app de demo versionada
    migrations/
    seed/
  docs/
    decisions/
    threat-model.md
    runbook.md
    postmortem-*.md
```

Dependencias clave: `@modelcontextprotocol/sdk`, `zod`, `drizzle-orm`, `pg-boss`,
`@opentelemetry/*`, `vitest`, `k6`.

**No** escribir un framework de agentes propio como objetivo. Loop fino propio + SDK para
llamadas al modelo. El valor está en gateway, evals, executor y estado.

---

## 14. Fases (8 semanas)

| Semana | Entregable | DoD |
|---|---|---|
| 1 | Dominio sembrado + `mcp-ops` con 10 tools de lectura (stdio) | `list_services`/`query_metrics`/`search_logs` responden con datos realistas; tests de contrato |
| 2 | Transporte HTTP + auth + orquestador v0 + persistencia de runs/steps + CLI | Un run completo por CLI produce timeline en Postgres |
| 3 | Gateway: allowlist, validación, rate limit, secretos, redacción, audit | Suite de policy tests; audit verificable por hash chain |
| 4 | Dos fases + `SimulatedExecutor` + inyección de fallos + aprobaciones + UI timeline/aprobación | Un rollback requiere aprobación, es idempotente ante reintento y maneja 409/timeout |
| 5 | Harness de evals + 40 casos + gate en CI | `pass@1` medido y reproducible; gate bloquea una regresión inyectada |
| 6 | Presupuestos, OTel, red-team, k6, modelo de coste | 20/20 inyecciones bloqueadas; presupuesto correcto con 20 runs paralelos |
| 7 | `SandboxExecutor` (kind) + suite de contrato + deploy público con `DEMO_MODE` + circuit breaker | 6/6 contrato real; demo pública con techo de gasto y fallback a replay |
| 8 | Runbook + simulacro de incidente + postmortem + README/ADRs/honestidad + benchmark + vídeo | Un desconocido entiende el proyecto en 5 min y no puede abusar de la demo |

**Recortes si vas justo:** terceros MCP, SSO, `DemoStackExecutor`, multi-región,
`query_readonly_sql`.
**Nunca recortes:** evals, aprobaciones, audit, presupuesto, `SimulatedExecutor` con fallos.

---

## 15. Artefactos a publicar

1. **README** con: problema → arquitectura → 3 decisiones → números → cómo correrlo →
   **tabla de honestidad** → limitaciones conocidas.
2. **ADRs** (§19).
3. **Tabla de benchmark reproducible**: `pass@1`, false-action rate, fault-handling rate, €/run,
   p95, y script.
4. **Threat model** de una página.
5. **Runbook + postmortem** de un incidente provocado a propósito.
6. **Enlace al último run de contrato contra sandbox real** (prueba de que no es teatro).
7. **Vídeo de 3 min** con el guion de §16.
8. **3 posts**: "por qué el gateway", "cómo evalúo un agente no determinista",
   "el día que el agente intentó obedecer a un log".

---

## 16. Guion del vídeo (3 min)

1. (0:00-0:20) "Checkout 5xx subió al 4% hace 20 minutos." → run en vivo.
2. (0:20-1:20) Timeline: métricas → deploy correlacionado → logs → traza → hipótesis con
   evidencia citada.
3. (1:20-2:00) Propuesta de rollback con blast radius → modal de aprobación → `apply` en
   **sandbox real** → readiness verificado → audit log.
4. (2:00-2:40) "Este prompt nuevo bajó el pass rate de 0,86 a 0,71; el CI lo bloqueó." →
   dashboard de evals + caso de inyección rechazado.
5. (2:40-3:00) Números: €/run, p95, 0 escrituras sin aprobación, 0 acciones sin verificar.

---

## 17. Métricas objetivo (definition of done)

| Métrica | Objetivo |
|---|---|
| `pass@1` golden set | ≥ 0,85 |
| False-action rate (casos "no actuar") | 0 |
| Inyecciones bloqueadas | 20/20 |
| Fault-handling (5 escenarios) | 5/5 |
| Suite de contrato sandbox | 6/6 en el último run nocturno |
| Escrituras sin aprobación | 0 |
| Acciones `applied` sin verificar post-condición | 0 |
| Coste mediano por run | ≤ €0,10 |
| p95 de run | ≤ 30 s |
| Cobertura de policy tests | 100% de reglas del gateway |
| Fugas de presupuesto en concurrencia | 0 |
| Sesiones de demo por encima de presupuesto | 0 |

Si no se alcanza `pass@1 ≥ 0,85`, se recorta el alcance de las tools de escritura, no se
falsean los números.

---

## 18. Preguntas de entrevista que invita (y dónde está la respuesta)

| Pregunta | Dónde |
|---|---|
| ¿Cómo evitas que borre producción? | Deny list + dos fases + aprobación (§3.5, §4.6) |
| ¿Cómo sabes que un cambio de prompt no lo rompió? | Gate de evals con baseline (§8.4) |
| ¿Qué pasa si reintenta un rollback? | Idempotencia + `action_effects` (§6.3, §7) |
| ¿Cómo verificas que el rollback funcionó? | Post-condición + `verified` (§6.3) |
| ¿Qué pasa si el proveedor devuelve 409? | Inyección de fallos (§6.4) |
| ¿Qué es real y qué simulado? | Tabla de honestidad (§11.7) |
| ¿Por qué no dejas escribir en la demo pública? | Tres capas + `DEMO_MODE` (§12, §4.11) |
| ¿Cómo facturas por tenant? | `usage_ledger` + reserva atómica (§4.5, §7) |
| ¿Qué logueas y qué redactas? | Redacción + payload hash (§4.7, §9) |
| ¿Cómo testeas algo no determinista? | Fixtures + 3 niveles de aserción (§8.2) |
| ¿Por qué TypeScript y no Go? | ADR-001 con disparador de extracción (§19) |
| ¿Por qué gateway y no auth en cada server? | ADR-003 |

---

## 19. Decisiones cerradas (índice de ADRs)

Detalle e índice en [`docs/decisions/`](./decisions/README.md). Cada decisión se escribe
como ADR con [`playbook/_template-adr.md`](../playbook/_template-adr.md) al empezar a
implementarla.

| ADR | Decisión | Consecuencia principal |
|---|---|---|
| **001** | TypeScript en todo el monorepo (Node 22) | Un contrato único; Go queda como extracción futura con disparador medido |
| **002** | Streamable HTTP en producción, stdio en local; revisión de spec fijada | Auth y multi-tenant reales; local sin fricción |
| **003** | Gateway como punto único de enforcement | Políticas centralizadas; un solo sitio que auditar |
| **004** | Escrituras en dos fases + aprobación humana | Nada destructivo sin humano; idempotencia obligatoria |
| **005** | Executor puerto/adaptador: `simulated` por defecto, `sandbox` demostrado | Demo segura + prueba real; evals deterministas |
| **006** | Demo en tres capas con `DEMO_MODE` y circuit breaker | Cero abuso, cero caídas mudas, conversión alta |
| **007** | Harness de evals propio con fixtures (promptfoo solo como contraste) | Control total de asserts de trayectoria e invariantes |
| **008** | `pg-boss` sobre Postgres; Temporal solo si aparece necesidad medida | Una dependencia menos; reanudación suficiente |

---

## 20. Riesgos y recortes

| Riesgo | Mitigación |
|---|---|
| La demo pública se cae el día de la entrevista | uptime monitor + fallback `REPLAY_ONLY` + vídeo |
| Gasto descontrolado | techo global + circuit breaker + modelo barato |
| Evals flaky por el sandbox | sandbox solo en suite nocturna; CI usa fixtures |
| Semana 7 sobrecargada | `SandboxExecutor` solo para `rollback`; el resto sigue simulado |
| Drift entre demo y repo | misma imagen, solo cambia configuración; prohibido fork de código |
| `pass@1` por debajo del objetivo | recortar tools de escritura, no maquillar números |

---

## 21. Decisiones abiertas (menores)

1. **`query_readonly_sql`:** recomendación = **no en v1**; en v2 como vistas restringidas con
   `statement_timeout` y límite de filas.
2. **Temporal:** recomendación = **no**; `pg-boss` + write-ahead cubre el caso. Revisar si la
   reanudación se vuelve un problema real.
3. **Destino de deploy:** Fly.io/Railway (rápido, ~10-20 €/mes) vs VPS propio (más control, más
   runbook). Pendiente de decidir.
4. **Proveedor(es) de modelo:** uno barato para demo, uno fuerte para evals; decidir si se
   soportan dos proveedores (más realismo, más superficie).

---

## 22. Arranque (cuando se dé la señal)

Checklist del día 1, en orden:

1. Verificar la **última revisión estable de MCP** y fijarla en
   `docs/decisions/002-mcp-transport.md` (con `playbook/_template-adr.md`).
2. Crear monorepo: `pnpm` workspaces + `turbo` + `tsconfig` base + `vitest`.
3. `docker compose` con Postgres y el generador de seed determinista.
4. `packages/core`: schemas zod de las 10 tools de lectura + tipo `ActionExecutor`.
5. Spike de medio día: `mcp-ops` con `list_services` y `query_metrics` por stdio, invocado desde
   un cliente de prueba. Si esto funciona, el resto es execution.
6. Escribir ADR-001, 002 y 003 (media página cada uno).
7. Definir el "done" de la semana 1 y no pasar a la 2 hasta cumplirlo.
