import { describe, expect, it } from "vitest";
import { compareSequence, SequenceSchema } from "./index.js";

describe("identifiers", () => {
  it("compares sequences without losing bigint precision", () => {
    const left = SequenceSchema.parse("9007199254740993");
    const right = SequenceSchema.parse("9007199254740994");
    expect(compareSequence(left, right)).toBe(-1);
    expect(compareSequence(right, right)).toBe(0);
  });
});
