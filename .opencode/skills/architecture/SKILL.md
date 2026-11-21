---
name: Architecture
description: Reglas de fronteras entre paquetes, capas, composition root, contratos Zod, errores, persistencia, colas, gateway, executor y evals. Úsala al agregar features, tools, endpoints, casos de uso, repositorios, jobs, migraciones o tests, y al revisar si un cambio respeta la arquitectura.
---

# Arquitectura

Resumen accionable de las reglas de diseño. **Fuente de verdad:**
`playbook/architecture.md` (desde la raíz del repo). Abrir solo la sección que haga
falta.

## Cuándo usarla

- Agregar una feature, tool MCP, endpoint, caso de uso, repositorio o job.
- Revisar un cambio y decidir en qué paquete y capa va cada cosa.
- Diseñar validación, manejo de errores, persistencia o tests.
- Evaluar si una dependencia nueva rompe las fronteras.
- Tocar prompts, descripciones de tools o el orquestador (implica evals).

## Fronteras entre paquetes

| Paquete | Responsabilidad | Importa |
|---------|-----------------|---------|
| `core` | dominio, schemas, ports, errores | solo Zod |
| `mcp-ops` | servidor MCP y handlers de tools | `core` |
| `gateway` | allowlist, presupuesto, aprobación, audit | `core` |
| `orchestrator` | loop, estado, reanudación | `core` |
| `executors` | `ActionExecutor` (simulated, sandbox) | `core` |
| `evals` | harness, casos, fixtures, gate | `core`, `gateway`, `orchestrator`, `executors`, `mcp-ops` (tools), `seed` (fixtures) |
| `apps/*` | HTTP, cola, composición | todos |

`core` no importa nada interno. Ningún paquete importa una app. `web` solo consume
DTOs.

## Capas dentro de una app

```text
HTTP → http → application → ports → adapters → DB / MCP / cola
                         ↘ domain
```

| Capa | Hace | No hace |
|------|------|---------|
| `http` | rutas y mapeo HTTP | SQL, MCP, executors |
| `application` | casos de uso y transacciones | Fastify, Drizzle, SDK MCP |
| `domain` | tipos y reglas puras | I/O |
| `ports` | interfaces | implementaciones |
| `adapters` | Postgres, pg-boss, MCP, executors | HTTP |
| `composition` | wiring | lógica de negocio |

## Reglas no negociables

- Un composition root por proceso: `createApp` y `createWorker`.
- Controller no toca la base; caso de uso no importa Fastify.
- Validar en el borde con Zod (`parse`, no `validate`).
- Un schema por tool en `core` es la fuente única del contrato.
- Errores con `AppError` + handler central; no filtrar stack ni SQL.
- SQL parametrizado; transacciones en el caso de uso.
- Config validada al arrancar; nada de `process.env` disperso.
- Jobs idempotentes, con reintentos y backoff acotados.
- Listados paginados con límite máximo y orden estable.

## Reglas propias

- Toda tool call pasa por el **gateway**.
- Escrituras en dos fases: `propose_*` → aprobación → `apply`.
- `tenant_id`/`user_id` server-side, nunca del modelo.
- Presupuesto con reserva atómica; idempotencia persistida.
- Deny list explícita; post-condición verificada tras `apply`.
- Cambio de prompt/tool/modelo → `pnpm evals` (y `pnpm evals:gate` antes del PR).

## Flujo para un cambio

1. Identificar paquete y capa; si toca varias, justificar el límite.
2. Definir el contrato (schema Zod / tipo) antes de implementar.
3. Inyectar dependencias nuevas desde el composition root.
4. Implementar la regla en el caso de uso, la persistencia en el repositorio.
5. Agregar tests en la capa correcta y eval si cambia el agente.
6. Verificar que la dirección de dependencias no se invirtió.

## Anti-patrones frecuentes

| Anti-patrón | Alternativa |
|-------------|-------------|
| Handler con SQL | repositorio |
| Caso de uso importa Fastify | DTOs |
| Orquestador llama a MCP directo | gateway |
| `tenant_id` desde el modelo | sesión server-side |
| Write sin `propose`/`apply` | dos fases |
| `new Repository()` en el servicio | inyección desde el root |
| Validar en el caso de uso | schema en el borde |
| Interpolar input en SQL | parámetros |
| Job no idempotente | clave de idempotencia |
| Cambiar un prompt sin eval | gate de evals |

## Referencias (leer bajo demanda)

| Necesito... | Sección |
|-------------|---------|
| Fronteras y capas completas | `playbook/architecture.md` → Fronteras / Capas |
| Composition root | → Composition root |
| Contratos y validación | → Contratos y validación |
| Reglas del proyecto | → Reglas del proyecto |
| Errores | → Errores |
| Persistencia | → Persistencia |
| Colas | → Asíncrono y colas |
| Evals | → Evals |
| Anti-patrones | → Anti-patrones |
| Checklist de PR | `playbook/checklists/pull-request.md` |

## Verificación

```powershell
pnpm typecheck
pnpm lint
pnpm test
```
