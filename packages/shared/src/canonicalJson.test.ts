import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonicalJson.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: "first" })).toBe(
      '{"a":"first","z":[{"a":1,"b":2}]}',
    );
  });

  it("uses JSON semantics for omitted and array undefined values", () => {
    expect(canonicalJson({ omitted: undefined, values: [undefined, null] })).toBe(
      '{"values":[null,null]}',
    );
  });

  it("rejects a value that JSON cannot serialize", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});
