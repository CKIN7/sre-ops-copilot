# Checklist de pull request

> Usar antes de abrir o mergear un PR. Si algo no aplica, tacharlo con una razón.

## Alcance

- [ ] Un solo tema; si hay refactor y feature, están separados.
- [ ] La rama nace de `main` (`feature/*`, `fix/*`, `docs/*`; `hotfix/*` también de
      `main`).
- [ ] El nombre de la rama describe el cambio.
- [ ] El diff no incluye archivos generados, logs, `.env` ni datos reales.
- [ ] No se reintrodujo el kit portable original (`engineering-playbook-kit/`).

## Commits

- [ ] Mensajes en Conventional Commits con ámbito de paquete o app.
- [ ] Un commit por archivo, salvo pares atómicos (`package.json` +
      `pnpm-lock.yaml`).
- [ ] El cuerpo explica el porqué, no el diff.
- [ ] No hay commits `WIP` ni fixups.

## Validación

- [ ] `pnpm install --frozen-lockfile` desde cero.
- [ ] `pnpm typecheck` y `pnpm lint` en verde.
- [ ] `pnpm build` en verde.
- [ ] `pnpm test` y `pnpm test:integration` en verde.
- [ ] `pnpm db:migrate` probado (si hay cambios de esquema).
- [ ] `pnpm evals` ejecutado (si toca prompts, tools, modelo u orquestador).
- [ ] La suite de integración usa la base de test, no la de desarrollo.
- [ ] Se probó el flujo manual descrito en el PR.

## Arquitectura

- [ ] La dependencia va hacia adentro y respeta las fronteras de paquetes.
- [ ] `core` no importa paquetes internos; ningún paquete importa una app.
- [ ] El handler HTTP no accede a la base ni al cliente MCP.
- [ ] El caso de uso no importa Fastify, Drizzle ni el SDK de MCP.
- [ ] Las dependencias nuevas se inyectan desde el composition root.
- [ ] El contrato de la tool está definido una sola vez en `packages/core`.
- [ ] La entrada está validada con el schema correspondiente.
- [ ] Los errores usan `AppError` y el handler central.
- [ ] El SQL es parametrizado; las transacciones están en el caso de uso.

## Gateway, escrituras y evals

- [ ] Toda tool call pasa por el gateway; no hay llamadas directas a MCP.
- [ ] `tenant_id`/`user_id` se resuelven server-side.
- [ ] Las escrituras son en dos fases (`propose_*` → aprobación → `apply`).
- [ ] La acción tiene clave de idempotencia persistida.
- [ ] El presupuesto se reserva antes de la llamada.
- [ ] Tras `apply` se verifica la post-condición (`verified` o `degraded`).
- [ ] Si cambió el comportamiento del agente, hay caso de eval nuevo o actualizado.
- [ ] `pass@1` no cae por debajo del baseline y no hay invariantes violadas.

## Datos y operación

- [ ] La migración es compatible hacia atrás y es idempotente.
- [ ] La paginación tiene límite máximo y orden estable.
- [ ] Los jobs nuevos son idempotentes y tienen reintentos acotados.
- [ ] La configuración nueva está validada al arrancar y documentada en `.env.example`.
- [ ] No se exponen paneles internos ni endpoints de admin sin autenticación.
- [ ] Si toca la demo, `DEMO_MODE` sigue sin permitir escrituras reales.

## Documentación

- [ ] Se actualizó el README o la doc correspondiente.
- [ ] Se registró una decisión en `docs/decisions/` si cambió la arquitectura.
- [ ] Se actualizó la tabla de honestidad (real vs simulado) si cambió el alcance.
- [ ] El índice de documentación refleja el estado real.

## Merge

- [ ] CI verde.
- [ ] Al menos un reviewer aprobó (auto-revisión permitida en repo individual).
- [ ] Merge commit (`--no-ff`), nunca squash ni rebase.
- [ ] La rama se borró después del merge.
