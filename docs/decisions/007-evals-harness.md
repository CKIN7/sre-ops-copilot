# 007 - Harness de evals propio con fixtures, gate en CI

> **Estado:** Aceptada
> **Fecha:** 2026-11-21
> **Decisores:** implementación asistida, revisión del autor

## Contexto

El plan §8 exige medir el comportamiento del agente con 40 casos de golden set sobre
10 arquetipos, 20 de red-team, aserciones en tres niveles y un gate en CI que bloquee
regresiones. El único modelo es guionizado y determinista: no hay LLM, tokens ni
coste. Tampoco existen juicios humanos para calibrar un juez.

El seed es determinista, pero sus ventanas son relativas a `now()`: una fixture
grabada deja de ser válida si el seed envejece. El gate no puede depender de que
Postgres tenga datos recientes.

## Problema

¿Cómo evaluar trayectoria, respuesta e invariantes de forma reproducible y barata,
sin fingir un juez LLM ni esconder que `pass@5` no puede diferir de `pass@1` con un
modelo determinista?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|--------|----------|-------------|
| A. Juez LLM calibrado | Métrica final más rica | No hay juicios humanos; coste y no determinismo en CI |
| B. Solo tests del orquestador | Barato | No evalúa arquetipos, ni trayectoria, ni red-team |
| C. Harness propio con modelo guionizado y fixtures VCR | Determinista, barato, ejecuta gateway/orquestador reales | La rúbrica final es determinista, no semántica |
| D. Grabar solo contra Postgres en CI | Fidelidad de SQL | Seed viejo rompe el gate; CI más lento y frágil |

## Decisión

Se implementa **C**:

- `ScriptedEvalModel` recibe el guion del caso y resuelve cada paso contra el catálogo
  real de tools leyendo nombre y descripción. No es un LLM, pero la selección sí
  depende de la descripción, que es lo que el meta-eval muta.
- El harness ejecuta el `Orchestrator` y `createToolGateway` reales. Solo sustituye
  el `McpTransport`: fixtures VCR o runner in-process de `mcp-ops`.
- Aserciones en tres niveles: rúbrica determinista de la respuesta, trayectoria
  (orden, deny list, escritura única) e invariantes (secretos, identidad, propuesta,
  presupuesto, post-condición).
- Las escrituras se aprueban como lo haría un humano y se repite la aprobación para
  comprobar idempotencia.
- `pnpm evals:record` graba contra Postgres si hay `DATABASE_URL`; sin ella, regenera
  con el generador determinista del seed en un instante fijo.
- El gate compara con `baseline.json` y falla con caída de `pass@1` >3 pp, coste
  >120% o cualquier violación de invariante.
- El meta-eval muta `query_metrics` y exige que los casos afectados fallen; un control
  neutro sobre `get_oncall` no debe romper nada.

Queda **fuera de alcance**: un juez LLM, un modelo live con coste y la programación
semanal del modo live.

## Consecuencias

- **Positivas:** gate determinista sin Postgres; 60 casos ejecutados en segundos;
  detección real de una degradación de catálogo; la rúbrica y sus límites se pueden
  auditar.
- **Negativas:** la rúbrica final es más débil que un juez calibrado; `pass@5` es
  igual a `pass@1` y se documenta; las fixtures sin `DATABASE_URL` no reproducen el
  SQL de agregación al bit.
- **Seguimiento:** programar el modo live semanal y, si algún día existen juicios
  humanos, evaluar un juez calibrado contra ellos.

## Referencias

- Código: `packages/evals`, `packages/mcp-ops/src/tools/registry.ts`.
- Documentación: `docs/plan.md` §8 y §8.7, `packages/evals/README.md`.
- ADRs previos: 003 (gateway único), 004 (dos fases), 005 (executor).
