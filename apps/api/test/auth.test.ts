import { describe, expect, it } from "vitest";

import { createAuthenticator } from "../src/http/auth.js";
import { loadConfig } from "../src/config.js";

const TOKEN = "test-operator-token-0123456789abcdef";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused",
  AUTH_TOKENS_JSON: JSON.stringify({
    [TOKEN]: {
      tenant: "shop",
      user: "oncall@shop.test",
      agent: "incident-copilot",
    },
  }),
  MCP_URL: "http://127.0.0.1:4000/mcp",
  MCP_AUTH_TOKEN: "service-token-0123456789abcdef0123456789",
});

const authenticate = createAuthenticator(config.tokens);

describe("createAuthenticator", () => {
  it("resuelve la selección del token válido", () => {
    expect(authenticate(`Bearer ${TOKEN}`)).toEqual({
      tenant: "shop",
      user: "oncall@shop.test",
      agent: "incident-copilot",
    });
  });

  it("acepta el esquema bearer sin distinguir mayúsculas", () => {
    expect(authenticate(`bearer ${TOKEN}`)).toMatchObject({ tenant: "shop" });
  });

  it.each([
    ["sin header", undefined],
    ["otro esquema", `Basic ${TOKEN}`],
    ["token vacío", "Bearer "],
    ["token incorrecto", "Bearer otro-token-0123456789abcdef"],
  ])("rechaza %s", (_label, header) => {
    let thrown: unknown;
    try {
      authenticate(header);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "unauthorized", statusCode: 401 });
  });
});