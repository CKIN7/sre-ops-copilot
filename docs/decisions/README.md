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

## Por qué estas y no otras

- **001** evita duplicar el contrato de las tools en dos lenguajes. Go queda como
  extracción futura, con disparador medido (CPU sostenida >70% de un core con 50 runs
  concurrentes, o >200 runs/s).
- **003** concentra allowlist, presupuesto y audit en un solo lugar auditable.
- **005** permite demo segura y evals deterministas sin renunciar a una prueba real
  contra `kind`.
- **006** evita abuso y caídas: la demo pública nunca ejecuta escrituras reales.

## Decisiones abiertas

| Tema | Estado | Nota |
|------|--------|------|
| `query_readonly_sql` | Pendiente | Recomendación: no en v1; v2 con vistas restringidas |
| Destino de deploy | Pendiente | Fly.io por defecto; Railway como alternativa |
| Proveedor de modelo | Pendiente | Uno barato para demo, uno fuerte para evals |
