# 012 - Audit encadenado por hash y rate limit con ventana deslizante en Postgres

> **Estado:** Aceptada
> **Fecha:** 2026-11-20
> **Decisores:** equipo del proyecto (diseño de M3)

## Contexto

M3 (`docs/plan.md` §14) pide al gateway: allowlist, validación, rate limit, secretos,
redacción y audit, con el DoD "suite de policy tests; audit verificable por hash chain".
Al cerrar M2 ya existen allowlist (`packages/gateway/src/allowlist.ts`) y validación
(`packages/gateway/src/validate.ts`); la redacción vive en
`packages/core/src/redaction/redact.ts` y la usan hoy las tools y el orquestador. Faltan
rate limit, secrets y audit.

Dos decisiones condicionan el resto:

1. **Dónde vive el estado del rate limit.** `docs/plan.md` §4.4 pide ventana deslizante
   "por run, por tenant y por tool". El estado en memoria del proceso es simple, pero no
   reparte entre réplicas y no sirve para el techo global por IP/sesión que necesita la
   demo pública (M7) ni para el "circuit breaker" que el plan describe como parte del
   discurso (§4.11).
2. **Qué significa "audit verificable".** Un `audit_log` append-only con `payload_hash`
   demuestra que el contenido no cambió; con `prev_hash` y `hash` demuestra además que
   **nadie insertó ni borró filas**. Sin esa segunda mitad, un atacante con acceso a la
   tabla puede reescribir la historia y recalcular los hashes.

Restricciones del repo: `packages/gateway` solo puede importar `@beacon/core`
(`playbook/architecture.md` §Capas), las migraciones son SQL versionado con runner propio
(ADR-009) y todo lo que se persiste pasa por redacción de secretos y PII (no negociable 7
de `AGENTS.md`).

## Problema

1. ¿Dónde se guarda el contador del rate limit y cómo se cuenta una ventana deslizante?
2. ¿Cómo se hace el audit tamper-evident y cómo se verifica?

## Opciones consideradas

### Rate limit

| Opción | Ventajas | Desventajas |
|--------|----------|-------------|
| **Eventos en Postgres, contador por ventana (elegida)** | Ventana deslianza real; reparte entre réplicas; el mismo mecanismo sirve para el techo global de la demo (M7); auditable | Una escritura por tool call; necesita limpieza de eventos viejos |
| Contadores en memoria del proceso | Cero latencia, cero esquema | No reparte entre réplicas; reiniciar el proceso reinicia el presupuesto; imposible un techo global |
| Contador con `UPDATE ... SET n = n + 1` (fijo) | Una fila por ámbito | Es una ventana fija, no deslizante: deja pasar el doble al cruzar el borde |

### Audit

| Opción | Ventajas | Desventajas |
|--------|----------|-------------|
| **Hash chain con `prev_hash` + `hash` y verificación explícita (elegida)** | Alterar o borrar una fila rompe la cadena de forma detectable; verificable sin herramienta externa | Hay que serializar la fila de forma canónica; dos escrituras concurrentes pueden bifurcar la cadena si no se serializan |
| Solo `payload_hash` | Simple | Detecta alterar el contenido, pero no insertar ni borrar filas |
| Cadena firmada con clave por entrada | Cada fila verificable por separado | Gestión de claves que el modelo de un solo servicio no necesita |
| Solo logs estructurados (pino) | Barato | Mutable, sin garantía de integridad, se pierde al rotar |

## Decisión

1. **El estado del rate limit vive en Postgres** (`rate_limit_events`), una fila por tool
   call aceptada, con `tenant_id`, `run_id`, `tool` y `created_at`. El límite se evalúa
   contando los eventos de la ventana deslizante; no hay contadores que reiniciar.
2. **Tres ámbitos, tres límites**: por run, por tenant y por tool dentro del tenant. La
   llamada se permite solo si ninguno de los tres supera su límite; si alguno lo supera, se
   rechaza con `rate_limited` y **no** se registra el evento (una llamada rechazada no
   consume presupuesto).
3. **La evaluación es atómica**: la comprobación y el registro ocurren en la misma
   transacción y bajo un `pg_advisory_xact_lock` por ámbito, para que dos réplicas
   concurrentes no puedan pasar ambas el mismo límite.
4. **El audit es append-only con hash chain**: cada fila guarda `payload_hash` (SHA-256
   del payload canónico), `prev_hash` (hash de la fila anterior) y `hash` (SHA-256 de la
   fila canónica completa, incluido `prev_hash`). La fila se calcula sobre una
   serialización canónica estable (`stableStringify` de `packages/core/src/domain/json.ts`),
   nunca sobre el JSON crudo.
5. **La cadena no se bifurca**: el escritor toma un `pg_advisory_xact_lock` global de audit
   antes de leer el último `hash` y escribir el siguiente. El coste es serializar las
   escrituras de audit; el beneficio es una cadena única, que es justo lo que se quiere
   verificar.
6. **Se audita lo que el modelo puede hacer, no lo que el modelo dice**: actor
   (`agent:<name>` / `user:<email>`), acción (`tool.call.allowed`, `tool.call.denied`,
   `tool.call.error`, `tool.call.result`), target (`<tool>#<runId>`) y payload con los
   argumentos **ya redactados**.
7. **El payload se redacta antes de persistirse** y lo que se guarda es su hash, no el
   contenido. Un email, una IP o un token no llega nunca a `audit_log`, ni siquiera
   cifrado: no está, y el hash lo demuestra.
8. **La verificación es explícita y reproducible**: un recorrido de la cadena que recalcula
   cada `hash` y comprueba que `prev_hash` enlaza con la fila anterior. Se expone como
   endpoint de la API y como comando de CLI (`beacon audit verify`), para que cualquiera
   pueda comprobar la integridad sin leer SQL.
9. **Las implementaciones viven en los adaptadores, no en el gateway**: `packages/core`
   define los puertos `AuditLog` y `RateLimiter`; `apps/api/src/adapters` implementa ambos
   contra Postgres; `packages/gateway` solo conoce los puertos (ADR-003, decisión 5).

Fuera de alcance: presupuesto económico y `usage_ledger` (M6), `DEMO_MODE` y circuit
breaker (M7), auditoría del ciclo de vida del run (el audit de M3 cubre tool calls; el
`run.started` / `run.finished` llegará con la cola en M4).

## Consecuencias

- **Positivas:** el rate limit es real entre réplicas y auditable; el audit detecta
  alteraciones, inserciones y borrados; la política vive en el gateway y se prueba sin
  base de datos; la verificación de integridad es una orden, no una tarea manual.
- **Negativas:** una escritura en Postgres por tool call (rate limit) y otra por tool call
  (audit): el camino caliente crece; el `pg_advisory_xact_lock` global de audit serializa
  las escrituras; hay que purgar eventos de rate limit viejos para que la tabla no crezca
  sin límite.
- **Seguimiento:**
  - Definir y medir la purga de `rate_limit_events` antes de que el volumen lo exija
    (retención por edad, con el mismo patrón que el resto del dataset sembrado).
  - El techo global por IP y por sesión de la demo (M7) reutiliza el mismo mecanismo de
    ventana deslizante con otro ámbito, no otro diseño.
  - Si el audit pasa a cubrir el ciclo de vida del run, el puerto `AuditLog` ya lo permite:
    solo cambia quién lo llama.

## Referencias

- Código: `packages/core/src/ports/audit-log.ts`, `packages/core/src/ports/rate-limiter.ts`,
  `packages/gateway/src/gateway.ts`, `apps/api/src/adapters/audit-log.ts`,
  `apps/api/src/adapters/rate-limiter.ts`, `infra/migrations/migrations/0004_audit.sql`,
  `infra/migrations/migrations/0005_rate_limit.sql`.
- Documentación: `docs/plan.md` §4.4, §4.7, §4.8, §14 y §17; `playbook/architecture.md`
  (§Capas, §Persistencia); `AGENTS.md` (no negociables 1, 4, 5 y 7).
- ADRs relacionados: 003 (gateway como punto único), 009 (migraciones), 010 (redacción).
