# 001 - TypeScript en todo el monorepo con Node 22 y pnpm

> **Estado:** Aceptada
> **Fecha:** 2026-11-17
> **Decisores:** equipo del proyecto (cierre de la decisión estructural de `docs/plan.md` §13)

## Contexto

Beacon es un monorepo con seis paquetes (`core`, `gateway`, `orchestrator`, `executors`,
`evals`, `mcp-ops`) y tres apps (`api`, `worker`, `web`). Los schemas Zod de las tools son el
contrato compartido entre gateway, servidor MCP, orquestador, evals y UI. El proyecto lo
mantiene una sola persona y debe poder levantarse y validarse sin sorpresas en cualquier
máquina.

Versiones verificadas en el registro npm el 2026-11-17:

| Herramienta | Dato verificado |
|---|---|
| `typescript` | `latest` = `7.0.2`; la línea 6.x termina en `6.0.3` |
| `pnpm` | `latest` = `12.21.0`; el entorno local traía `12.10.1` |
| `eslint@10.15.0` | `engines.node`: `^20.19.0 \|\| ^22.13.0 \|\| >=24` |
| `vitest@5.1.0` | `engines.node`: `^22.12.0 \|\| ^24.0.0 \|\| >=26` |
| `typescript-eslint@8.73.0` | `peerDependencies.typescript`: `>=4.8.4 <6.1.0`; `eslint`: `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` |
| `@modelcontextprotocol/server@2.4.0` | `engines.node`: `>=20` |

## Problema

¿Con qué lenguaje, runtime, gestor de paquetes y versiones exactas arranca el monorepo, y por
qué se fijan esas versiones y no las más nuevas?

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|---|---|---|
| **TypeScript estricto en todo el monorepo (elegida)** | Un único contrato Zod; un solo lenguaje y toolchain; el cuello de botella es el modelo, no la CPU | Renuncia temporal a la velocidad del compilador nativo 7 |
| TypeScript + Go en el worker | Más rendimiento bruto en el loop | Duplica el contrato de tools: el drift que el proyecto dice resolver |
| TypeScript 7.0.2 (compilador nativo) | Compilación mucho más rápida | `typescript-eslint@8.73.0` no la soporta (`<6.1.0`): hoy rompe el gate de lint |
| pnpm flotante o sin pin | Cero mantenimiento | Instalaciones no reproducibles entre local y CI |
| pnpm 12.10.1 (la instalada) | Ya estaba en la máquina | Greenfield sin lockfile legado: no hay motivo para arrancar once parches atrás |

## Decisión

1. **TypeScript estricto en todo el monorepo.** Un solo contrato en `packages/core`. Go queda
   como extracción futura con disparador medido (`docs/plan.md` §13: CPU sostenida >70% de un
   core con 50 runs concurrentes, o >200 runs/s).
2. **Node 22 LTS:** `engines.node` = `">=22.13.0"`.
   - El suelo es **22.13.0 y no 22.12.0** porque `eslint@10.15.0` exige `^22.13.0`; con 22.12
     el lint no arranca. `vitest@5.1.0` admitiría 22.12, pero manda la restricción más
     restrictiva del toolchain.
   - No se pone techo `<23`: el entorno local verificado corre Node `24.16.0` y también pasa el
     `engines` de ESLint (`>=24`). El CI fijará Node 22 como pide `playbook/devops.md`.
3. **TypeScript `6.0.3`, no `7.0.2`.**
   - `7.0.2` es la línea del compilador nativo; `typescript-eslint@8.73.0` declara soporte
     `typescript >=4.8.4 <6.1.0`, así que hoy la 7 deja el lint sin soporte oficial. `6.0.3` es
     la última 6.x.
   - **Disparador para revisitar:** que `typescript-eslint` publique soporte para 7 y que
     `build`, `typecheck`, `test` y `lint` pasen con la nativa; entonces se abre un ADR de
     actualización con la comparación medida.
4. **pnpm `12.21.0`, versión exacta en `packageManager`.**
   - Es el `latest` del major 12 (el 12.10.1 del entorno era solo el binario instalado). En un
     repo nuevo se fija la última estable del major y se verifica que instala: `pnpm --version`
     en el repo reporta `12.21.0` (pnpm auto-gestiona la versión declarada).
   - Sin rango flotante: dev y CI comparten la misma versión exacta. Subir pnpm es un `chore`
     deliberado con lockfile regenerado, nunca un efecto colateral de instalar.
5. **Módulos ESM** (`"type": "module"`, `module`/`moduleResolution` `NodeNext`), build con
   `tsc`, tests con `vitest@5.1.0`, tareas con `turbo@2.11.11`, lint con
   `eslint@10.15.0` + `typescript-eslint@8.73.0` en flat config.
6. **Workspaces**: `packages/*` + `infra/*`; el lockfile es único y se commitea.
7. `zod@4.6.7` compartido (ADR-002: el SDK MCP v2 exige zod 4).

## Consecuencias

- **Positivas:** contrato único y verificable; versiones exactas y reproducibles; el lint y el
  typecheck bloquean la subida accidental a TypeScript 7; el suelo de Node está alineado con la
  dependencia más restrictiva, no con una suposición.
- **Negativas:** se renuncia de momento a la velocidad del compilador nativo; hay que subir a
  mano TypeScript y pnpm en cada revisión; el CI debe fijar Node 22 (>=22.13) y pnpm 12.21.0,
  no confiar en los defaults del runner.
- **Seguimiento:** revisar TypeScript 7 y pnpm al inicio de cada mes; cualquier cambio de
  versiones pasa por `pnpm install --frozen-lockfile`, `build`, `typecheck`, `test` y `lint` en
  verde antes de mergear.

## Referencias

- Código: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`,
  `eslint.config.mjs`, `packages/*/package.json`, `infra/*/package.json`.
- Documentación: `docs/plan.md` §13 y §19; `playbook/architecture.md`; `playbook/devops.md`
  (CI fija `node-version: 22`); `playbook/contributing.md`.
- ADRs previos: 002 (MCP y zod 4).
