import { describe, expect, it, vi } from "vitest";

import { ApiClient, ApiError } from "../src/api/client.js";

/**
 * Tests del cliente de la API.
 *
 * Lo que importa: el bearer viaja en la cabecera (nunca en la URL), los errores de
 * la API se traducen a un error tipado y las decisiones mandan la razón.
 */
describe("ApiClient", () => {
  it("manda el bearer en la cabecera y no en la URL", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ token: "secreto", fetchImpl });
    await client.listRuns();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/runs");
    expect(calls[0]?.url).not.toContain("secreto");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secreto");
  });

  it("traduce un error de la API a un error tipado", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "forbidden", message: "no aprobado" } }),
          { status: 403 },
        ),
    ) as unknown as typeof fetch;

    const client = new ApiClient({ token: "t", fetchImpl });

    await expect(client.approve("abc", "adelante")).rejects.toBeInstanceOf(ApiError);
    await expect(client.approve("abc", "adelante")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "no aprobado",
    });
  });

  it("envía la razón al aprobar y al rechazar", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ proposal: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ token: "t", fetchImpl });
    await client.approve("abc", "el pico es real");
    await client.reject("abc", "no es el momento");

    expect(bodies[0]).toContain("el pico es real");
    expect(bodies[1]).toContain("no es el momento");
  });

  it("propone con la tool, los args y el run", async () => {
    let body: unknown;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ proposal: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ token: "t", fetchImpl });
    await client.propose({
      tool: "propose_rollback",
      args: { service: "checkout" },
      runId: "run-1",
    });

    expect(body).toEqual({
      tool: "propose_rollback",
      args: { service: "checkout" },
      run_id: "run-1",
    });
  });
});
