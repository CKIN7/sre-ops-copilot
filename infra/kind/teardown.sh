#!/usr/bin/env bash
# Borra el cluster de kind de la suite de contrato. Nunca toca otros clusters.
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-beacon-sandbox}"
if command -v kind >/dev/null 2>&1 && kind get clusters | grep -qx "${CLUSTER}"; then
  kind delete cluster --name "${CLUSTER}"
else
  echo "no hay cluster kind ${CLUSTER}; nada que borrar"
fi
