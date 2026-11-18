# 011 - Excepción de arranque: commits directos a `main` hasta cerrar la semana 1

> **Estado:** Aceptada (excepción temporal, con caducidad)
> **Fecha:** 2026-11-18
> **Decisores:** equipo del proyecto

## Contexto

`playbook/contributing.md` exige PR obligatorio a `main`, checks en verde y merge commits.
Durante el arranque no existe ninguna de las piezas que hacen útil esa regla: `.github/workflows`
está vacío, `main` no tiene protección y el repo tiene un solo autor. Un PR sin CI no verifica
nada; solo añade ceremonia.

Los 37 commits del día 1 (scaffold, migraciones, seed y el spike de dos tools) ya están en `main`
y publicados en `origin`. La regla de no reescribir historia publicada sigue vigente, así que esos
commits no se mueven.

## Decisión

1. Mientras dure la **semana 1** (scaffold y las 10 tools de lectura), los commits van directos a
   `main`, atómicos, con Conventional Commits y sin squash ni rebase.
2. Nada publicado se reescribe: no hay `force-push` sobre `main`.
3. La excepción **caduca al cerrar la semana 1**. El primer commit de la semana 2 abre `feature/*`
   y entra por PR con merge commit.
4. Antes de ese primer PR: workflow de CI (`typecheck`, `lint`, `test`, `build`) y protección de
   `main` (PR obligatorio, checks verdes, merge commit, sin force-push).

## Opciones consideradas

| Opción | Ventajas | Desventajas |
|---|---|---|
| **Excepción temporal documentada (elegida)** | No bloquea el arranque con un gate que aún no comprueba nada; queda constancia de por qué la historia no muestra PRs | La semana 1 no tiene revisión ni checks; hay que recordar cerrar la excepción |
| Abrir PRs desde ya sin CI | Historia conforme al playbook | El PR no verifica nada: un humano aprueba 25 archivos a ciegas; trabajo duplicado |
| Introducir `develop` | Flujo con rama de integración | Contradice la decisión trunk-based y añade una rama que nadie pidió |
| Reescribir `main` para simular PRs | Historia "bonita" | Viola no reescribir historia publicada y rompe cualquier clon existente |

## Consecuencias

- **Positivas:** el arranque no se bloquea con un gate que todavía no comprueba nada; la deuda de
  proceso queda fechada y con un disparador claro de caducidad.
- **Negativas:** la historia de la semana 1 no muestra revisión ni checks; la constancia vive aquí
  y en la nota de `playbook/contributing.md`, no en los commits.
- **Seguimiento:** al abrir el primer PR de la semana 2, verificar que la protección de `main` está
  activa y que el workflow corre en ese PR. Si la semana 1 se alarga, se actualiza este ADR con la
  nueva fecha, no se prorroga en silencio.

## Referencias

- `playbook/contributing.md` (modelo de ramas y reglas duras).
- `AGENTS.md` (convenciones).
- `docs/plan.md` §14 (calendario por semanas).
