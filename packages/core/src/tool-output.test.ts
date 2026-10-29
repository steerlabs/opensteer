import { describe, expect, it } from "vitest";
import {
  ToolOutputSchema,
  createToolOutput,
  normalizeToolOutput,
  toolOutputTextMaxBytes,
  utf8ByteLength,
  utf8Prefix,
} from "./tool-output.js";

describe("canonical tool output", () => {
  it("keeps a UTF-8-safe head and tail within the byte limit", () => {
    const source = `HEAD-${"🙂".repeat(20_000)}-TAIL`;
    const output = createToolOutput(source);

    expect(output.text.startsWith("HEAD-")).toBe(true);
    expect(output.text.endsWith("-TAIL")).toBe(true);
    expect(output.text).toContain("bytes omitted");
    expect(output.truncation).toEqual({
      omittedBytes: expect.any(Number),
      originalBytes: utf8ByteLength(source),
    });
    expect(utf8ByteLength(output.text)).toBeLessThanOrEqual(toolOutputTextMaxBytes);
    expect(output.text).not.toContain("�");
    expect(ToolOutputSchema.parse(output)).toEqual(output);
  });

  it("projects semantic text blocks without adding a provider contract", () => {
    expect(
      normalizeToolOutput({ content: [{ text: "first", type: "text" }, { text: "second" }] }),
    ).toEqual({ text: "first\nsecond" });
  });

  it("takes a valid UTF-8 prefix for live stream budgets", () => {
    expect(utf8Prefix("a🙂b", 4)).toBe("a");
    expect(utf8Prefix("a🙂b", 5)).toBe("a🙂");
  });

  it("replaces NUL with the replacement character and keeps the text length", () => {
    const source = `before${"\u0000".repeat(5_000)}after`;
    const output = createToolOutput(source);

    expect(output.text).not.toContain("\u0000");
    expect(output.text).toBe(`before${"�".repeat(5_000)}after`);
    expect(output.text.length).toBe(source.length);
    expect(output.truncation).toBeUndefined();
    expect(ToolOutputSchema.parse(output)).toEqual(output);
  });

  it("holds the byte budget when NUL expansion straddles both truncation windows", () => {
    // Each NUL is one byte here and three once replaced, so a source that fits
    // the budget must still truncate. NULs sit at the head window, the tail
    // window and the omitted middle so every boundary is crossed by one.
    const source = "\u0000".repeat(toolOutputTextMaxBytes);
    const output = createToolOutput(source);

    expect(output.text).not.toContain("\u0000");
    expect(utf8ByteLength(output.text)).toBeLessThanOrEqual(toolOutputTextMaxBytes);
    expect(output.text.startsWith("�")).toBe(true);
    expect(output.text.endsWith("�")).toBe(true);
    expect(output.text).toContain("bytes omitted");
    expect(output.truncation).toEqual({
      omittedBytes: expect.any(Number),
      // The budget describes the sanitized text, which is what gets stored.
      originalBytes: utf8ByteLength("�".repeat(toolOutputTextMaxBytes)),
    });
    expect(ToolOutputSchema.parse(output)).toEqual(output);
  });

  it("strips NUL from structured output projections too", () => {
    expect(normalizeToolOutput({ content: "head\u0000tail" })).toEqual({ text: "head�tail" });
  });

  it("rejects manually constructed oversized canonical output", () => {
    expect(
      ToolOutputSchema.safeParse({ text: "x".repeat(toolOutputTextMaxBytes + 1) }).success,
    ).toBe(false);
  });
});
