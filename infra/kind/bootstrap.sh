#!/usr/bin/env bash
# Crea el cluster de kind para la suite de contrato del SandboxExecutor (M7).
#
# No se ejecuta en el gate de PR: es la preparacion del job nocturno o manual.
# Falla con el error exacto si Docker o kind no estan disponibles; no simula 6/6.
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-beacon-sandbox}"
NAMESPACE="${SANDBOX_NAMESPACE:-beacon-sandbox}"

if ! command -v docker >/dev/null 2>&1; then
  echo "bloqueado: docker no esta instalado" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "bloqueado: el daemon de Docker no responde" >&2
  exit 1
fi
if ! command -v kind >/dev/null 2>&1; then
  echo "bloqueado: kind no esta instalado (https://kind.sigs.k8s.io/)" >&2
  exit 1
fi
if ! command -v kubectl >/dev/null 2>&1; then
  echo "bloqueado: kubectl no esta instalado" >&2
  exit 1
fi

if ! kind get clusters | grep -qx "${CLUSTER}"; then
  kind create cluster --name "${CLUSTER}" --wait 180s
fi

kubectl config use-context "kind-${CLUSTER}"
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl cluster-info --context "kind-${CLUSTER}"
echo "cluster ${CLUSTER} listo; namespace ${NAMESPACE}"
echo "siguiente: pnpm contract:sandbox"
