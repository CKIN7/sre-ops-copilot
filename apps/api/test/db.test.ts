import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { guardPoolErrors } from "../src/adapters/db.js";

describe("guardPoolErrors", () => {
  it("absorbe el error de un client idle en vez de tumbar el proceso", () => {
    const pool = new EventEmitter() as unknown as Pool;
    const onError = vi.fn();

    guardPoolErrors(pool, onError);

    expect(() =>
      pool.emit("error", new Error("Connection terminated unexpectedly")),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});