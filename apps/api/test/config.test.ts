import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const TOKEN = "test-operator-token-0123456789abcdef";
const SERVICE_TOKEN = "service-token-0123456789abcdef0123456789";

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "3000",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://beacon:beacon@localhost:5432/beacon",
    AUTH_TOKENS_JSON: JSON.stringify({
      [TOKEN]: {
        tenant: " shop ",
        user: " OnCall@Shop.Test ",
        agent: " incident-copilot ",
      },
    }),
    MCP_URL: "http://127.0.0.1:4000/mcp",
    MCP_AUTH_TOKEN: SERVICE_TOKEN,
  };
}

describe("loadConfig", () => {
  it("normaliza slugs y email y parsea los tokens", () => {
    const config = loadConfig(validEnv());

    expect(config).toMatchObject({
      nodeEnv: "test",
      port: 3000,
      logLevel: "silent",
      mcpUrl: "http://127.0.0.1:4000/mcp",
    });
    expect(config.tokens).toHaveLength(1);
    expect(config.tokens[0]?.selection).toEqual({
      tenant: "shop",
      user: "oncall@shop.test",
      agent: "incident-copilot",
    });
    expect(config.tokens[0]?.digest).toHaveLength(32);
  });

  it("aplica defaults de desarrollo sin inventarse secretos", () => {
    const env = validEnv();
    delete env.NODE_ENV;
    delete env.PORT;
    delete env.LOG_LEVEL;

    const config = loadConfig(env);

    expect(config.nodeEnv).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  it("falla si falta DATABASE_URL", () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it("falla si AUTH_TOKENS_JSON no es JSON", () => {
    const env = { ...validEnv(), AUTH_TOKENS_JSON: "no-es-json" };

    expect(() => loadConfig(env)).toThrow(/AUTH_TOKENS_JSON no es JSON válido/);
  });

  it("falla si un token es demasiado corto", () => {
    const env = {
      ...validEnv(),
      AUTH_TOKENS_JSON: JSON.stringify({
        short: { tenant: "shop", user: "oncall@shop.test", agent: "incident-copilot" },
      }),
    };

    expect(() => loadConfig(env)).toThrow(/AUTH_TOKENS_JSON inválido/);
  });

  it("falla si no hay ningún token", () => {
    const env = { ...validEnv(), AUTH_TOKENS_JSON: "{}" };

    expect(() => loadConfig(env)).toThrow(/al menos un token/);
  });

  it("falla si el token de servicio es demasiado corto", () => {
    const env = { ...validEnv(), MCP_AUTH_TOKEN: "corto" };

    expect(() => loadConfig(env)).toThrow(/MCP_AUTH_TOKEN/);
  });

  it("valida la configuracion del sandbox al arrancar", () => {
    const env = {
      ...validEnv(),
      EXECUTOR: "sandbox",
      SANDBOX_TARGET: "kind",
      READINESS_TIMEOUT: "45s",
    };

    const config = loadConfig(env);
    expect(config.executor).toBe("sandbox");
    expect(config.sandbox.readinessTimeoutMs).toBe(45_000);

    expect(() => loadConfig({ ...env, READINESS_TIMEOUT: "45" })).toThrow(
      /READINESS_TIMEOUT/,
    );
    expect(() => loadConfig({ ...env, SANDBOX_TARGET: "docker" })).toThrow(
      /SANDBOX_TARGET/,
    );
  });

  it("DEMO_MODE exige executor simulado y fixtures de replay", () => {
    expect(() =>
      loadConfig({ ...validEnv(), DEMO_MODE: "1", EXECUTOR: "sandbox" }),
    ).toThrow(/EXECUTOR=simulated/);

    expect(() => loadConfig({ ...validEnv(), DEMO_MODE: "1" })).toThrow(
      /DEMO_REPLAY_FIXTURES/,
    );

    const config = loadConfig({
      ...validEnv(),
      DEMO_MODE: "1",
      DEMO_REPLAY_FIXTURES: "packages/evals/fixtures/golden",
    });
    expect(config.demo.enabled).toBe(true);
    expect(config.demo.replayOnly).toBe(false);
    expect(config.rateLimit.session).toBe(6);
  });

  it("REPLAY_ONLY sin DEMO_MODE falla cerrado", () => {
    expect(() => loadConfig({ ...validEnv(), REPLAY_ONLY: "1" })).toThrow(
      /REPLAY_ONLY=1 exige DEMO_MODE=1/,
    );
  });
});