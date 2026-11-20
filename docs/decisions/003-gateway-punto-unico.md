# 003 - El gateway es el punto único de enforcement

> **Estado:** Aceptada
> **Fecha:** 2026-11-17
> **Decisores:** equipo del proyecto (decisión estructural de `docs/plan.md` §2 y §19)

## Contexto

Beacon mueve datos entre un agente y sistemas de dominio. El agente decide *qué* tool
invocar; el servidor MCP sabe *cómo* responder a cada tool. Entre ambos hay al menos tres
decisiones que no pueden depender del modelo:

1. **Autorización:** qué tools puede usar este agente en este tenant.
2. **Validez:** si los argumentos cumplen el contrato de la tool antes de gastar una llamada.
3. **Riesgo:** qué se audita, qué se redacta, qué se limita y qué exige aprobación.

`docs/plan.md` §2 dibuja el gateway como una capa entre el orquestador y los servidores
MCP, y §4 enumera diez políticas que deben vivir ahí. La alternativa habitual —validar
dentro de cada tool o en el propio orquestador— reparte la política por el código y hace
que "dónde se decide esto" sea una pregunta sin respuesta única.

## Problema

¿Dónde viven las políticas de autorización, validación, redacción, auditoría, presupuesto y
aprobación: en el gateway, en cada tool o en el orquestador?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|--------|----------|-------------|
| **Gateway como punto único (elegida)** | Una política, un sitio auditable; el orquestador no conoce el transporte; añadir una tool no obliga a repartir reglas | Un salto extra en el camino de cada llamada; el gateway tiene que ser pequeño y rápido |
| Validar dentro de cada tool | Cada tool es responsable de sus reglas | Las tools no saben quién llama; imposible aplicar una política transversal (rate limit, presupuesto, audit) sin duplicarla N veces |
| Validar en el orquestador | Sin salto extra | El orquestador se convierte en el punto de enforcement, pero el plan exige que las escrituras y las tools se puedan llamar desde otros caminos (UI, evals, replay) sin saltarse la política |
| Política en el servidor MCP | El servidor ve todo | Mezcla datos con política; el mismo servidor puede servir a varios agentes con políticas distintas; el modelo de ningún tenant |

## Decisión

1. **El gateway es el único punto por el que se alcanza una tool.** El orquestador nunca
   habla directo con un servidor MCP: habla con el puerto `ToolGateway` de
   `packages/core/src/ports/tool-gateway.ts`.
2. **Las políticas viven en el gateway**: allowlist, validación, rate limit, secretos,
   redacción, audit, presupuesto y aprobación. `playbook/architecture.md` (§Capas) fija que
   el paquete `gateway` es el dueño de esa lista.
3. **La identidad es server-side.** `tenant_id`, `user_id` y `agent_id` los inyecta el
   borde autenticado (la API resuelve el token contra el control plane) y viajan en el
   contexto de la llamada. El modelo no los aporta ni puede alterarlos.
4. **El deny list es explícito.** El agente no tiene `exec_shell`, `delete_*`,
   `scale_down`, `rotate_secret`, `query_arbitrary_sql` ni `modify_iac`. La allowlist se
   resuelve server-side desde `agents.allowed_tools`; un nombre desconocido es un error de
   configuración, no una tool que el modelo pueda intentar.
5. **El gateway no decide reglas de negocio ni habla SQL.** Es una política: recibe
   dependencias por puertos (`packages/core/src/ports`) y las implementaciones viven en
   adaptadores (`apps/api/src/adapters`). Así el gateway se prueba sin base de datos.

Fuera de alcance de esta decisión: el contenido concreto de cada política (rate limit,
presupuesto, aprobación, auditoría), que se decide en su propio ADR — ver
[ADR-012](./012-audit-y-rate-limit.md) para audit y rate limit.

## Consecuencias

- **Positivas:** "qué puede hacer el agente" se responde leyendo un solo paquete; el
  orquestador es intercambiable sin tocar la política; añadir una tool es añadir un schema
  y una allowlist, no tres sitios donde validar; los tests de política no necesitan
  Postgres ni red.
- **Negativas:** todo tool call paga un salto extra; el gateway acumula responsabilidades y
  hay que vigilar que no crezca hasta ser un monolito de políticas; los ports de `core`
  crecen con cada política nueva.
- **Seguimiento:**
  - Cada política nueva (rate limit, presupuesto, aprobación) llega con su ADR y con un
    test de política en `packages/gateway/test`.
  - Si una tool necesita conocer al llamante más allá de tenant/agente/run, la política
    se resuelve en el gateway con un port nuevo, no abriendo un canal lateral.

## Referencias

- Código: `packages/gateway/src/gateway.ts`, `packages/gateway/src/allowlist.ts`,
  `packages/gateway/src/validate.ts`, `packages/core/src/ports/tool-gateway.ts`.
- Documentación: `docs/plan.md` §2, §3.5, §4 y §19; `playbook/architecture.md`
  (§Capas y responsabilidades, §Principios 7); `AGENTS.md` (no negociables 1, 3 y 5).
- ADRs relacionados: 001 (stack), 002 (MCP), 012 (audit y rate limit).
