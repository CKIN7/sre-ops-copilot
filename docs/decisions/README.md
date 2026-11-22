# Decisiones de arquitectura (ADR)

Índice de las decisiones tomadas para Beacon. Cada ADR se escribe con
[`_template-adr.md`](../../playbook/_template-adr.md) y se nombra
`NNNN-slug.md` en este directorio.

| ADR | Decisión | Estado |
|-----|----------|--------|
| 001 | TypeScript en todo el monorepo (Node 22, pnpm) | Aceptada |
| 002 | MCP por Streamable HTTP en producción y stdio en local; revisión fijada | Aceptada |
| 003 | Gateway como punto único de enforcement | Aceptada |
| 004 | Escrituras en dos fases con aprobación humana | Aceptada |
| 005 | `ActionExecutor` puerto/adaptador: simulado por defecto, sandbox real | Aceptada |
| 006 | Demo en tres capas con `DEMO_MODE` y circuit breaker | Aceptada |
| 007 | Harness de evals propio con fixtures, gate en CI | Aceptada |
| 008 | `pg-boss` sobre PostgreSQL; Temporal solo con necesidad medida | Aceptada |
| 009 | Migraciones: SQL versionado en `infra/migrations` con runner propio (no `drizzle-kit`) | Aceptada |
| 010 | `get_trace_summary` derivado de `metrics_series`; sin tabla de trazas | Aceptada |
| 011 | Excepción de arranque: commits directos a `main` hasta cerrar la semana 1 | Caducada (cerrada con M1) |
| 012 | Audit encadenado por hash y rate limit con ventana deslizante en Postgres | Aceptada |
| 013 | Presupuesto con reserva atomica en Postgres y liquidacion append-only | Aceptada |
| 014 | OTel en proceso, sin exporter externo obligatorio | Aceptada |
| 015 | Sandbox real y `DEMO_MODE` forzado en el gateway | Aceptada |

## Por qué estas y no otras

- **001** evita duplicar el contrato de las tools en dos lenguajes. Go queda como
  extracción futura, con disparador medido (CPU sostenida >70% de un core con 50 runs
  concurrentes, o >200 runs/s).
- **003** concentra allowlist, presupuesto y audit en un solo lugar auditable.
- **004** hace que la fase de ejecución no sea alcanzable por el modelo: `apply` no es
  una tool y la aprobación es un hecho persistido, con idempotencia por restricción
  única en vez de por lógica condicional.
- **005** permite demo segura y evals deterministas sin renunciar a una prueba real
  contra `kind`.
- **006** evita abuso y caídas: la demo pública nunca ejecuta escrituras reales.
- **007** fija un harness determinista con modelo guionizado y fixtures VCR, en vez de
  un juez LLM que no se puede calibrar; el meta-eval demuestra que el harness detecta
  una degradación de catálogo y sus límites quedan escritos.
- **009** deja el SQL como única fuente de verdad del esquema y evita un paquete `db` que la
  estructura objetivo no contempla; Drizzle ORM sigue siendo la capa de consulta.
- **010** evita una tabla de trazas fuera del modelo aprobado y que `get_trace_summary`
  contradiga a `query_metrics`; los externos se declaran sin instrumentar en vez de con ceros.
- **011** evitó un PR sin CI durante el arranque y dejó fechada la vuelta al flujo normal. La
  excepción caducó y se cerró con M1: el ruleset `main-protection` y el workflow de CI
  (`typecheck`, `lint`, `test`, `build`) ya están activos, y todo cambio entra por PR con merge
  commit.
- **012** fija dónde vive el estado del rate limit (Postgres, con ventana deslizante real, no
  contadores en memoria) y cómo el audit demuestra que nadie reescribió la historia: hash chain
  con `prev_hash`, escritura serializada y verificación explícita.
- **015** separa el sandbox real (solo rollback, suite nocturna) de la demo pública (sesión,
  techo, breaker y replay), y deja la política de demo en el gateway, no en la UI.

## Decisiones abiertas

| Tema | Estado | Nota |
|------|--------|------|
| `query_readonly_sql` | Pendiente | Recomendación: no en v1; v2 con vistas restringidas |
| Destino de deploy | Pendiente | Fly.io por defecto; Railway como alternativa |
| Proveedor de modelo | Pendiente | Uno barato para demo, uno fuerte para evals |

La decisión de migraciones quedó cerrada en el ADR-009 (SQL versionado + runner propio).
