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
 * Con 20 VUs se satura el rate limit por tool (`RATE_LIMIT_TOOL=120` por
 * minuto) y una parte de los runs termina en `rate_limited`. Eso es un
 * resultado valido del gobierno, pero no mide la latencia de un run completo:
 * `run_complete_ms` solo suma runs `succeeded` y `run_succeeded` reporta la
 * proporcion. Para una corrida sin saturacion, usar `-e VUS=8`.
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
const runSucceeded = new Rate("run_succeeded");

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

  if (!created) {
    runSucceeded.add(false);
    return;
  }

  const body = response.json();
  const runId = body.run.runId;
  const timeline = http.get(`${BASE_URL}/runs/${runId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    tags: { name: "GET /runs/:id" },
    timeout: "30s",
  });

  let status = "";
  try {
    status = timeline.json()?.run?.status ?? "";
  } catch {
    status = "";
  }
  const succeeded = status === "succeeded";
  check(timeline, {
    "GET /runs/:id devuelve 200": (res) => res.status === 200,
    "el run termino con exito": () => succeeded,
  });
  runSucceeded.add(succeeded);
  if (succeeded) {
    // Solo un run que termino en `succeeded` cuenta como run completo; los
    // `failed`/`rate_limited` se miden en `run_succeeded` y no contaminan p95.
    runComplete.add(response.timings.duration);
  }

  sleep(0.5);
}
