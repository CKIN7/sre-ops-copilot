import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

/**
 * k6 sobre el API de Beacon (docs/plan.md §10).
 *
 * Mide el camino real `POST /runs`: en esta version no hay cola, la peticion
 * ejecuta el run completo con el modelo guionizado y devuelve el resultado. Por
 * eso `run_complete_ms` es tambien la latencia de la peticion; no se publica un
 * "p95 de encolado" que no existe. Cuando la cola de M7 exista, se separa.
 *
 * Uso:
 *   k6 run -e BEACON_TOKEN=... -e VUS=20 -e DURATION=10s infra/k6/run-api.js
 *
 * Contra la API local, el token es el mismo de `AUTH_TOKENS_JSON` que usa el CLI.
 * El script no inventa resultados: si no hay API levantada, falla.
 */
const BASE_URL = __ENV.BEACON_API_URL || "http://127.0.0.1:3000";
const TOKEN = __ENV.BEACON_TOKEN || "";
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || "10s";

export const options = {
  scenarios: {
    runs: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:POST /runs}": ["p(95)<30000"],
    run_complete_ms: ["p(95)<30000"],
  },
};

const runComplete = new Trend("run_complete_ms", true);
const runCreated = new Rate("run_created");

export default function () {
  const payload = JSON.stringify({
    goal: "Investiga el pico de errores 5xx en checkout",
    trigger: "api",
  });

  const response = http.post(`${BASE_URL}/runs`, payload, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    tags: { name: "POST /runs" },
    timeout: "60s",
  });

  runComplete.add(response.timings.duration);

  const created = check(response, {
    "POST /runs devuelve 201": (res) => res.status === 201,
    "la respuesta trae runId": (res) => {
      try {
        const body = res.json();
        return typeof body?.run?.runId === "string";
      } catch {
        return false;
      }
    },
  });
  runCreated.add(created);

  if (created) {
    const body = response.json();
    const runId = body.run.runId;
    const timeline = http.get(`${BASE_URL}/runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      tags: { name: "GET /runs/:id" },
      timeout: "30s",
    });
    check(timeline, {
      "GET /runs/:id devuelve 200": (res) => res.status === 200,
      "el run termino": (res) => {
        try {
          const status = res.json()?.run?.status;
          return ["succeeded", "failed", "degraded", "cancelled"].includes(status);
        } catch {
          return false;
        }
      },
    });
  }

  sleep(0.5);
}
