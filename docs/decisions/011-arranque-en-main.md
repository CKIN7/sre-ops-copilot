# 011 - Excepción de arranque: commits directos a `main` hasta cerrar la semana 1

> **Estado:** Caducada y cerrada con M1 (2026-11-19)
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
   y entra por PR con merge commit. *(Cumplido: ver «Cierre».)*
4. Antes de ese primer PR: workflow de CI (`typecheck`, `lint`, `test`, `build`) y protección de
   `main` (PR obligatorio, checks verdes, merge commit, sin force-push). *(Cumplido: ver «Cierre».)*

## Cierre

La excepción **caducó y quedó cerrada al cerrar el hito M1**, el 2026-11-19. No se prorroga:
el primer cambio posterior a M1 entró por PR y todo cambio, incluida la documentación, sigue
ese flujo.

Evidencia del cierre:

1. **Protección de `main` activa** mediante el ruleset `main-protection` (id 27662072):
   PR obligatorio, merge commit como único método permitido (`merge`; squash y rebase
   deshabilitados), borrado y force-push bloqueados. Al ser un repo de un solo autor, el
   ruleset no exige aprobación de terceros (`required_approving_review_count: 0`).
2. **CI en `.github/workflows/ci.yml`** con cuatro jobs de nombre estable y exacto:
   `typecheck`, `lint`, `test` y `build`. El job `test` levanta un servicio `postgres:16`,
   aplica migraciones, siembra el dataset y ejecuta los tests de contrato contra la base.
3. **Primer PR**: #1 (`docs/plan-v3`) se fusionó con merge commit, sin commits directos a
   `main`.

La fase 2 de la protección —marcar `typecheck`, `lint`, `test` y `build` como *required
status checks* en el ruleset— queda pendiente de que el CI haya corrido al menos una vez en
un PR. Los nombres de los jobs no cambian.

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
- **Seguimiento:** cumplido. La protección de `main` está activa y el workflow corre en los PRs;
  la excepción se cerró al terminar M1 sin prórroga (ver «Cierre»). Si en el futuro hiciera falta
  otra excepción, se documenta en un ADR nuevo con fecha de caducidad, no se prorroga en silencio.

## Referencias

- `playbook/contributing.md` (modelo de ramas y reglas duras).
- `AGENTS.md` (convenciones).
- `docs/plan.md` §14 (fases e hitos M1-M8).
