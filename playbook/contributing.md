# Contribución

> **Tipo:** Guía · **Alcance:** ramas, commits, PRs, releases y hotfixes ·
> **Revisión:** 2026-11-15

Proceso por defecto para integrar cambios sin reescribir historia ni romper releases.
Este repositorio es **trunk-based**: hay una sola rama de integración (`main`) y las
features entran por PR. No hay `develop`.

## Contexto del proyecto

> **Adaptado a sre-ops-copilot.**

- Monorepo TypeScript: `apps/` (`api`, `worker`, `web`) + `packages/` (`core`,
  `mcp-ops`, `gateway`, `orchestrator`, `executors`, `evals`).
- Paquete raíz: `package.json`; lockfile `pnpm-lock.yaml`.
- Validación local: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`,
  `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm db:migrate`, `pnpm evals`.
- Ramas: `main`, `feature/*`, `fix/*`, `docs/*`, `hotfix/*`.
- Releases: tag `vX.Y.Z` sobre `main`.

---

## Principios

1. **Historia legible:** cada merge cuenta qué entró y cuándo.
2. **Un cambio por commit:** commits atómicos, con un motivo claro.
3. **Integración explícita:** se integra con merge commit, nunca con squash ni rebase.
4. **Lo publicado no se reescribe:** no force-push sobre `main`.
5. **Verde antes de integrar:** build, typecheck, tests, migraciones y evals pasan en
   local y en CI.

## Modelo de ramas

| Rama | Nace de | Se integra en | Propósito |
|------|---------|---------------|-----------|
| `main` | — | — | Releases estables y hotfixes. Solo recibe PRs. |
| `feature/*` | `main` | `main` (PR) | Nueva funcionalidad. |
| `fix/*` | `main` | `main` (PR) | Corrección no urgente. |
| `docs/*` | `main` | `main` (PR) | Cambios solo documentales. |
| `hotfix/*` | `main` | `main` (PR) | Corrección crítica en producción. |

```text
Feature:
  main ──► feature/x ──► PR (checks) ──► main (merge commit) ──► tag cuando toque

Hotfix:
  main ──► hotfix/x ──► PR (checks) ──► main ──► tag vX.Y.Z
```

Reglas:

- `main` está protegida: PR obligatorio, checks obligatorios y merge commits
  habilitados.
- No se hace push directo a `main`, ni siquiera para documentación.
- Una rama, un tema. Si el cambio crece, se parte en varias ramas.
- Las ramas `feature/*`, `fix/*` y `docs/*` se borran después del merge.

> **Excepción temporal (hito M1):** mientras no haya CI ni protección de `main`, los
> commits del arranque van directos a `main`. Caduca al cerrar M1: el primer
> commit de M2 abre `feature/*` y entra por PR con merge commit. (ADR-011 usa el
> vocabulario anterior y lo llama «semana 1»; es el mismo hito.) Detalle y
> disparador en [`docs/decisions/011-arranque-en-main.md`](../docs/decisions/011-arranque-en-main.md).
- `hotfix/*` se borra tras el tag.

### Nombres de rama

```text
feature/<slug-corto>     feature/gateway-budget
fix/<slug-corto>         fix/approval-resume
docs/<slug-corto>        docs/playbook-adoption
hotfix/<slug-corto>      hotfix/eval-gate-timeout
```

`kebab-case`, sin nombres de personas ni fechas. El idioma debe ser consistente en
todo el repositorio.

## Commits

Formato: Conventional Commits. El ámbito es el paquete o la app.

```text
<tipo>(<ámbito opcional>): <resumen en imperativo>

<por qué del cambio, si no es obvio>

<referencias: ADR-0005, issue #123>
```

| Tipo | Uso |
|------|-----|
| `feat` | funcionalidad nueva |
| `fix` | corrección de comportamiento |
| `refactor` | cambio interno sin cambio funcional |
| `test` | tests |
| `docs` | documentación |
| `chore` | tooling, dependencias, versiones |
| `ci` | workflows |
| `perf` | rendimiento |
| `build` | build, Docker, empaquetado |

Ámbitos válidos: `api`, `worker`, `web`, `core`, `mcp-ops`, `gateway`, `orchestrator`,
`executors`, `evals`, `infra`, `docs`.

```text
feat(gateway): reservar presupuesto antes de cada tool call
fix(orchestrator): reanudar desde el último step persistido
test(evals): cubrir timeout de readiness como degraded
```

Reglas:

- Un commit por archivo creado o modificado, salvo pares atómicos
  (`package.json` + `pnpm-lock.yaml`, snapshots generados).
- El resumen no termina en punto y cabe en ~72 caracteres.
- El cuerpo explica el **porqué**, no repite el diff.
- No hay commits `WIP`, `fixes`, `stuff` ni merges de trabajo ajeno a la rama.
- No mezclar refactor y cambio funcional en el mismo commit.

## Flujo de trabajo

1. Actualizar `main` y crear la rama:

   ```powershell
   git switch main
   git pull --ff-only
   git switch -c feature/nombre-corto
   ```

2. Implementar con commits atómicos.

3. Validar en local **antes** de abrir el PR:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint
   pnpm build
   pnpm test
   pnpm test:integration
   pnpm db:migrate
   pnpm evals
   ```

   `pnpm evals` es obligatorio si el cambio toca prompts, descripciones de tools,
   modelos o la lógica del orquestador.

4. Subir la rama y abrir PR a `main`.

5. Esperar CI verde. Si falla, corregir en la rama; no mergear en rojo.

6. Fusionar con merge commit y borrar la rama.

## Pull requests

- PRs pequeños: un tema, descripción con contexto y plan de prueba.
- El PR no reemplaza la validación local ni el CI.
- Merge con merge commit. Nunca squash, nunca rebase.
- En un repo de un solo desarrollador se permite la auto-revisión, pero el PR debe
  explicar el cambio igual: el historial es parte del portfolio.

Plantilla mínima:

```markdown
## Qué cambia
...

## Por qué
...

## Cómo probarlo
1. ...

## Evals
- [ ] No aplica (no toca prompts, tools, modelo ni orquestador)
- [ ] `pnpm evals` con pass@1 ≥ baseline

## Checklist
- [ ] typecheck, lint, build y tests en verde
- [ ] migraciones probadas (si aplica)
- [ ] docs actualizadas
- [ ] sin secretos ni datos reales
```

## Releases

Semver `MAJOR.MINOR.PATCH`:

- `MAJOR`: cambio incompatible de API, de contrato de tools o de datos.
- `MINOR`: funcionalidad compatible.
- `PATCH`: corrección compatible.

1. Subir la versión en la raíz:

   ```powershell
   pnpm version X.Y.Z --no-git-tag-version
   git add package.json pnpm-lock.yaml
   git commit -m "chore: release vX.Y.Z"
   ```

2. Abrir un PR de la rama de release a `main` (o commitear el bump en la rama de
   feature si el release es inmediato) y esperar los checks.
3. Fusionar con merge commit. Nunca squash ni rebase.
4. Crear el tag anotado sobre el merge commit:

   ```powershell
   git switch main
   git pull --ff-only
   git tag -a vX.Y.Z -m "Descripción del release"
   git push origin vX.Y.Z
   ```

   No usar `git push --tags`: subiría todos los tags locales.

## Hotfixes

Solo para errores críticos en producción que no pueden esperar al próximo release.

1. Crear la rama desde `main`:

   ```powershell
   git switch main
   git pull --ff-only
   git switch -c hotfix/nombre-del-error
   ```

2. Corregir con commits atómicos.
3. Subir la versión de parche. `package.json` y `pnpm-lock.yaml` van juntos:

   ```powershell
   pnpm version X.Y.Z --no-git-tag-version
   git add package.json pnpm-lock.yaml
   git commit -m "chore: release vX.Y.Z (hotfix)"
   ```

   El bump va al final. Si dos hotfixes corren en paralelo, el que mergea segundo
   rehace este commit con la versión siguiente antes de abrir el PR.

4. Validar antes de tocar `main`:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint
   pnpm build
   pnpm test
   pnpm db:migrate
   pnpm evals
   ```

5. Abrir un PR de `hotfix/*` a `main`, con checks verdes, y fusionar con merge commit.
6. Etiquetar el merge commit ya integrado:

   ```powershell
   git switch main
   git pull --ff-only
   git tag -a vX.Y.Z -m "Hotfix vX.Y.Z: descripción"
   git push origin vX.Y.Z
   ```

7. Borrar la rama:

   ```powershell
   git branch -d hotfix/nombre-del-error
   git push origin --delete hotfix/nombre-del-error
   ```

Si el hotfix toca migraciones, la migración tiene que ser compatible hacia atrás: la
versión anterior debe poder leer el esquema nuevo. Ver [`devops.md`](./devops.md#migraciones).

## CI para cambios de documentación

Para cambios exclusivamente documentales se puede evitar el CI con `[skip ci]` en el
mensaje del merge commit:

```powershell
git switch main
git pull --ff-only
git merge --no-ff docs/mi-cambio -m "Merge branch 'docs/mi-cambio' [skip ci]"
```

Cuidado: si el HEAD de `main` queda con esa instrucción, GitHub también omite el
workflow del PR siguiente y los checks requeridos quedan pendientes. Antes de abrir el
siguiente PR, `main` debe tener un commit sin la instrucción.

No usar este atajo en código, tests, migraciones ni workflows.

## Reglas duras

- No hacer commits directos a `main`; solo recibe merge commits vía PR.
- No usar squash ni rebase para integrar.
- Un commit por archivo, salvo pares atómicos.
- No reescribir commits ya publicados.
- No usar `git push --force` en `main`.
- Mantener los checks de CI en verde antes de cada release y cada hotfix.
- Nunca commitear `.env`, credenciales ni datos reales.
- Ningún cambio de prompt o de tool se mergea sin `pnpm evals`.

## Adaptación a otro proyecto

- Cambiar `apps/` y `packages/` por la ruta real y los comandos por los del gestor de
  paquetes correspondiente (`npm`, `yarn`, `uv`, `cargo`, etc.).
- Si el proyecto usa `develop`, reintroducir esa rama y el PR de release; este kit no
  la asume.
- Si el proyecto no es monorepo, ajustar los ámbitos de commit.
- Ajustar qué checks son obligatorios en la protección de `main`.
