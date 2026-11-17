# 002 - Transporte MCP: Streamable HTTP sin sesiones en producción y stdio en local

> **Estado:** Aceptada
> **Fecha:** 2026-11-17
> **Decisores:** equipo del proyecto (decisión delegada al arranque, ver `docs/plan.md` §22.1)

## Contexto

Beacon expone su superficie de herramientas por MCP desde `packages/mcp-ops` y la consume el
orquestador a través del gateway. El transporte y la revisión de la especificación condicionan
autenticación, aislamiento por tenant, escalado y operación.

Hechos verificados el 2026-11-15 (el sitio de MCP no era alcanzable desde el entorno; se
contrastaron contra los metadatos del registro npm):

- La última revisión estable de MCP es **`2026-07-28`** y sustituye a `2025-11-25`.
- El modelo es **stateless**: no hay handshake ni `Mcp-Session-Id`. El routing va por los
  headers `Mcp-Method` / `Mcp-Name` más `MCP-Protocol-Version`; si el header no coincide con el
  body se devuelve `-32020` (`HeaderMismatch`, HTTP 400). Las notificaciones van por
  `subscriptions/listen`.
- `Roots`, `Sampling` y `Logging` quedan deprecados (SEP-2577, ventana de 12 meses): no se
  construye sobre ellos.
- `HTTP+SSE` queda deprecado.
- El SDK v2 está dividido en `@modelcontextprotocol/server` y `@modelcontextprotocol/client`
  **2.4.0**; el paraguas `@modelcontextprotocol/sdk` sigue en la línea 1.x.

Claim pendiente ("zod 4 obligatorio y `zod-to-json-schema` fuera"), comprobado contra los
metadatos del registro antes de escribir este ADR:

| Paquete | `peerDependencies` | `dependencies` |
|---|---|---|
| `@modelcontextprotocol/server@2.4.0` | — (no declara) | `zod@^4.2.0`, `@modelcontextprotocol/core@2.4.0` |
| `@modelcontextprotocol/core@2.4.0` | — (no declara) | `zod@^4.2.0` |

Conclusión: el SDK v2 **arrastra zod 4 como dependencia directa** (`zod@^4.2.0`) y **no depende
de `zod-to-json-schema`**. El proyecto fija `zod@4.6.7` en `packages/core` para compartir una
sola instancia de Zod con el SDK; el claim se escribe aquí con este matiz, no como una regla
general de Zod.

## Problema

¿Qué transporte y qué revisión de la especificación fijamos para la superficie MCP, y con qué
paquetes del SDK?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|---|---|---|
| **Streamable HTTP stateless en producción + stdio en local/CI** | Escalado horizontal sin sticky sessions; auth y tenant en la capa HTTP; local sin fricción; sin deuda en APIs deprecadas | Sin reanudación de sesión de protocolo: el estado del run debe vivir en Postgres (ya previsto en el plan §5) |
| Streamable HTTP con sesiones de protocolo (modelo previo a `2026-07-28`) | Reanudación y notificaciones ligadas a sesión | Modelo sustituido; obliga a `Mcp-Session-Id` y afinidad; más estado que operar |
| HTTP+SSE | Compatibilidad con clientes antiguos | Deprecado en la revisión fijada |
| Solo stdio | Simple | No sirve para producción multi-tenant; sin auth ni aislamiento |
| SDK v1 (paraguas `@modelcontextprotocol/sdk`) | Ecosistema maduro | No implementa el modelo stateless de `2026-07-28` |

## Decisión

1. **Fijar la revisión `2026-07-28`** en el servidor, el cliente y los tests de contrato.
2. **Producción: Streamable HTTP en un único endpoint POST, sin sesiones de protocolo.**
   - La identidad (usuario y tenant) viaja en la capa HTTP y la resuelve el gateway; nunca el
     modelo ni el body de la tool.
   - El gateway verifica `MCP-Protocol-Version` y la coherencia header/body; un `-32020`
     (`HeaderMismatch`) se registra y **no ejecuta** la tool (400 al cliente).
   - Las notificaciones, si llegan a la UI, usan `subscriptions/listen`; nunca son una
     dependencia de corrección del run.
3. **Local y CI: stdio**, sin red y sin credenciales. Es el transporte del spike y de los tests
   de contrato.
4. **SDK v2**: `@modelcontextprotocol/server@2.4.0` en `mcp-ops` y
   `@modelcontextprotocol/client@2.4.0` en el cliente de spike (y, en la semana 2, en el
   orquestador). No se usa el paraguas `@modelcontextprotocol/sdk`.
5. **No construir sobre `Roots`, `Sampling` ni `Logging`**, ni sobre `HTTP+SSE`.
6. `zod@4.6.7` compartido entre `core` y el SDK; sin `zod-to-json-schema`.

Fuera de alcance: el endpoint HTTP de producción no se implementa en este scaffold; llega en la
semana 2 (plan §14). El spike actual usa únicamente stdio.

## Consecuencias

- **Positivas:** escalado horizontal sin estado de protocolo; la autorización queda toda en el
  gateway y el borde HTTP; local y CI funcionan sin red; nada que migrar cuando se retiren las
  APIs deprecadas.
- **Negativas:** el run necesita estado persistido y reanudación propia (coste ya asumido en el
  diseño del orquestador); las notificaciones requieren diseño adicional cuando se expongan a
  la UI; el SDK v2 es más nuevo que el paraguas 1.x y se fija con versión exacta.
- **Seguimiento:**
  - Semana 2: transporte HTTP con tests de `HeaderMismatch`, versión de protocolo y ausencia de
    sesión.
  - Revisar en cada subida de SDK que la revisión fijada sigue soportada y que zod sigue en la
    misma major.
  - Antes de que expire la ventana de SEP-2577, confirmar que no quedó ninguna dependencia de
    `Roots`, `Sampling` o `Logging`.

## Referencias

- Código (objetivo): `packages/mcp-ops/src/server.ts`, `packages/core/src/schemas`.
- Documentación: `docs/plan.md` §2, §3, §13 (corregida a `server`/`client`) y §22.1;
  `playbook/architecture.md` (MCP en `mcp-ops`, enforcement en `gateway`).
- Paquetes npm verificados: `@modelcontextprotocol/server@2.4.0`,
  `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/core@2.4.0`.
- ADRs relacionados: 001 (stack), 003 (gateway).
