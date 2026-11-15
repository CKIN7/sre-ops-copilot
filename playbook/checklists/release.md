# Checklist de release y hotfix

> Usar antes de cortar un release programado o un hotfix.

## Antes del release

- [ ] `main` está verde en CI.
- [ ] No hay PRs abiertos que deban entrar en este release.
- [ ] La versión sigue semver y el changelog está claro.
- [ ] `package.json` y `pnpm-lock.yaml` bumpeados en el mismo commit.
- [ ] Migraciones probadas desde cero y sobre datos existentes.
- [ ] Rollback definido: tag/imagen anterior identificado.
- [ ] Backups recientes de la base y volúmenes.

## Evals

- [ ] `pnpm evals` con `pass@1` ≥ baseline.
- [ ] False-action rate 0 en los casos de "no actuar".
- [ ] 20/20 inyecciones bloqueadas.
- [ ] Coste mediano por run ≤ €0,10 y p95 ≤ 30 s.
- [ ] Último run nocturno de contrato contra sandbox: 6/6.

## PR de release

- [ ] PR a `main` con resumen de cambios.
- [ ] Checks `build`, `test`, `migrations` y `evals` en verde.
- [ ] Merge commit, sin squash ni rebase.

## Tag y publicación

- [ ] Tag anotado `vX.Y.Z` sobre el merge commit.
- [ ] Se pushea solo ese tag (`git push origin vX.Y.Z`), no `--tags`.
- [ ] La imagen se publica con tag inmutable (`sha-<full>` y `X.Y.Z`).

## Deploy

- [ ] Environment `production` aprobado.
- [ ] Migraciones one-shot aplicadas.
- [ ] Deploy con `IMAGE_TAG=sha-<full>` completado.
- [ ] `GET /health/ready` responde 200 dentro del timeout.
- [ ] Logs sin errores nuevos durante los primeros minutos.
- [ ] Métricas de error, latencia y coste por run estables.

## Demo pública

- [ ] `DEMO_MODE` activo y `apply` real deshabilitado.
- [ ] Presupuesto por sesión y techo global configurados.
- [ ] Circuit breaker → `REPLAY_ONLY` probado.
- [ ] Resiembra nocturna programada.
- [ ] Uptime monitor apuntando a `/health`.

## Hotfix

- [ ] La rama nace de `main`.
- [ ] El bump de parche va en un commit aparte, al final.
- [ ] PR a `main` con checks verdes.
- [ ] Tag `vX.Y.Z` sobre el merge commit.
- [ ] Rama `hotfix/*` eliminada después del tag.
- [ ] Migración compatible hacia atrás.

## Después del release

- [ ] Verificación funcional del flujo crítico en producción.
- [ ] Incidentes o deuda detectada registrados como issue.
- [ ] Documentación e índice actualizados.
- [ ] Si algo falló, rollback ejecutado y post-mortem breve.
