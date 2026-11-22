# Suite de contrato del sandbox (M7)

Estos archivos preparan el cluster real de la suite de contrato de §8.6. **La suite
no se ejecuta en el gate de PR**: corre en el workflow nocturno o manual
(`.github/workflows/sandbox-contract.yml`).

```bash
# 1. Cluster (falla con el error exacto si falta docker/kind/kubectl)
./infra/kind/bootstrap.sh

# 2. Suite: 6 casos, evidencia por caso en artifacts/
SANDBOX_TARGET=kind \
SANDBOX_NAMESPACE=beacon-sandbox \
READINESS_TIMEOUT=10s \
pnpm contract:sandbox

# 3. Limpieza
./infra/kind/teardown.sh
```

Los casos 1-5 usan `kubectl` real (`rollout undo` sobre un deployment de nginx con
historial de ReplicaSets). El caso 6 (flag) es **simulado** porque el
`SandboxExecutor` solo cubre rollback; la evidencia lo etiqueta.

Si `kubectl cluster-info` falla, el comando sale con `1` y el mensaje exacto. No se
publica 6/6 si solo se ejecutó el `SimulatedExecutor`.
