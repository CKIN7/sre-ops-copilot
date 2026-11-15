---
name: Contributing
description: Proceso de contribución trunk-based del repo: ramas, commits, PRs a main, releases, hotfixes y docs-only. Úsala al crear ramas, commitear, mergear, abrir PRs, cortar un release o resolver un hotfix.
---

# Contribución

Resumen accionable del proceso. **Fuente de verdad:** `playbook/contributing.md`
(desde la raíz del repo). Abrir solo la sección que haga falta.

## Cuándo usarla

- Crear una rama, agrupar commits o integrar trabajo en `main`.
- Abrir un PR, cortar un release o resolver un hotfix.
- Decidir si un cambio puede usar `[skip ci]`.

No usarla para decidir el diseño del código: eso es la skill `architecture`.

## Reglas no negociables

- Repo **trunk-based**: no hay `develop`.
- `main` protegida: solo PRs, merge commits y checks verdes.
- Nada de squash ni rebase para integrar.
- Un commit por archivo, salvo `package.json` + `pnpm-lock.yaml`.
- No reescribir historia publicada ni force-push en `main`.
- Las ramas de feature se borran después del merge.
- Nunca commitear `.env`, credenciales ni datos reales.
- Cambio de prompt o tool sin `pnpm evals` no se mergea.

## Decisión rápida de rama

| Cambio | Rama | Base | Destino |
|--------|------|------|---------|
| Feature | `feature/<slug>` | `main` | `main` vía PR |
| Fix no urgente | `fix/<slug>` | `main` | `main` vía PR |
| Solo documentación | `docs/<slug>` | `main` | `main` vía PR |
| Error crítico en prod | `hotfix/<slug>` | `main` | `main` vía PR + tag |

## Flujo

1. `git switch main && git pull --ff-only`
2. `git switch -c <tipo>/<slug>`
3. Commits atómicos en Conventional Commits, con ámbito de paquete
   (`feat(gateway): ...`).
4. Validar:
   `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:integration && pnpm db:migrate`
5. `pnpm evals` si tocaste prompts, tools, modelo u orquestador.
6. Push de la rama y PR a `main`.
7. Checks verdes, merge commit, borrar la rama.

## Release

1. `pnpm version X.Y.Z --no-git-tag-version` en la raíz.
2. Commit `chore: release vX.Y.Z` con `package.json` + `pnpm-lock.yaml`.
3. PR a `main`, checks verdes, merge commit.
4. Tag anotado en `main`: `git tag -a vX.Y.Z -m "..."` y `git push origin vX.Y.Z`.
5. No usar `git push --tags`.

## Hotfix

1. Rama desde `main`; corregir; bump de parche al final.
2. PR a `main`, checks verdes, merge commit.
3. Tag `vX.Y.Z`; borrar la rama.
4. Migraciones compatibles hacia atrás.

## Docs-only y `[skip ci]`

- Solo para cambios exclusivamente documentales.
- `[skip ci]` en el merge commit.
- Si `main` queda con esa instrucción, el siguiente PR también se salta los checks:
  dejar un commit sin ella antes de abrir el PR.
- Nunca en código, tests, migraciones, workflows ni evals.

## Referencias (leer bajo demanda)

| Necesito... | Sección |
|-------------|---------|
| Diagramas y reglas de ramas | `playbook/contributing.md` → Modelo de ramas |
| Formato de commits | → Commits |
| Plantilla de PR | → Pull requests |
| Pasos de release | → Releases |
| Pasos de hotfix | → Hotfixes |
| Checklist pre-merge | `playbook/checklists/pull-request.md` |
| Checklist de release | `playbook/checklists/release.md` |

## Verificación

```powershell
git status --short
git log --oneline --graph -10
```
