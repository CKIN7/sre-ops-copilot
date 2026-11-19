import { describe, expect, it } from "vitest";

import { stableStringify } from "../src/domain/json.js";

describe("stableStringify", () => {
  it("ordena claves para que el hash no dependa del orden", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it("recorre arrays y objetos anidados", () => {
    expect(stableStringify({ list: [{ z: 1, a: 2 }] })).toBe('{"list":[{"a":2,"z":1}]}');
  });

  it("ignora claves undefined pero conserva null", () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
