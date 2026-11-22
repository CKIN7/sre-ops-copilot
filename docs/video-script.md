# Guion del video (3 minutos)

> Estado: **guion listo; grabacion pendiente**. El video no se puede generar
> desde el repositorio. No se publica como hecho hasta que exista el archivo.

Objetivo: que alguien que no conoce el proyecto entienda en 3 minutos que Beacon
investiga con evidencia, no escribe sin aprobacion y no puede abusar de la demo.

## Antes de grabar

1. Postgres migrado y seed reciente.
2. `mcp-ops` HTTP en `:4000`.
3. API en `:3000`.
4. UI en el puerto de Vite.
5. Cluster `kind` y `checkout` sano si se va a mostrar el sandbox.
6. Navegador sin secretos visibles: no mostrar el `.env` ni el token.
7. Cerrar pestañas y notificaciones.

## Storyboard

### 0:00-0:20 — El sintoma

- Plano: dashboard de `checkout` con `http_5xx_rate` en el pico.
- Voz: "Checkout sube al 4,2% de 5xx veinte minutos despues de un deploy. Beacon
  tiene que investigar, proponer y no tocar nada sin aprobacion."
- Texto en pantalla: `checkout`, `1.42.0`, `4,2%`.

### 0:20-1:20 — La investigacion

- Lanzar el run desde la UI o el CLI:
  `pnpm cli run --goal "Investiga el pico de errores 5xx en checkout"`.
- Mostrar la timeline: `query_metrics` -> `get_deploys` -> `search_runbooks`.
- Senalar la evidencia citada: maximo 4,2%, deploy `1.42.0` a las 01:13 y runbook
  de rollback encontrado.
- Voz: "El agente no inventa: cita la metrica, el deploy y el runbook. Este run
  es de solo lectura."

### 1:20-2:00 — La escritura gobernada

- Abrir la propuesta de rollback en la cola de aprobaciones.
- Mostrar diff, radio de impacto y evidencia.
- Aprobar con un motivo. La aprobacion ejecuta el `apply`.
- Mostrar el estado `applied` y `verified=true`.
- Si se muestra el sandbox: `kubectl rollout undo` y readiness real.
- Voz: "Sin esta aprobacion no hay escritura. El apply es idempotente y verifica
  la post-condicion; si no la verifica, queda `degraded`, no exito."

### 2:00-2:40 — Lo que bloquea el CI

- Mostrar `pnpm evals:gate`: 60/60, red-team 20/20.
- Mostrar una inyeccion rechazada y el gate que bloquea una regresion.
- Mostrar `pnpm evals:meta`: la mutacion de `query_metrics` lleva `pass@1` a 0%.
- Voz: "Un cambio de prompt o tool no entra sin eval. El gate bloquea la
  regresion; el meta-eval demuestra que el harness detecta de verdad."

### 2:40-3:00 — Numeros y honestidad

- Plano de la tabla de honestidad de `/about`.
- Voz: "0 escrituras sin aprobacion, 0 acciones aplicadas sin verificar, coste 0
  porque no hay LLM, p95 de run completo 1,24 s con runs exitosos. El incidente
  es sintetico, el sandbox cubre rollback y el caso de flag es simulado. Lo que
  no esta medido, se dice."

## Texto de cierre

> "Beacon no es un chatbot con tools: es la capa de gobierno que hace que un
> agente se pueda ejecutar en una empresa sin romper nada ni arruinarla."

## Checklist de grabacion

- [ ] El token no aparece en pantalla.
- [ ] El run mostrado es `succeeded` y la timeline es legible.
- [ ] La aprobacion tiene un motivo escrito.
- [ ] El estado final es `applied` + `verified` o `degraded` explicado.
- [ ] Se muestra la tabla de honestidad.
- [ ] Duracion <= 3:00.
- [ ] Se publica el enlace en el README al cerrar M8.
