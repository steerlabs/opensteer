import { describe, expect, it } from "vitest";
import { splitMessageText } from "./text.js";

describe("splitMessageText", () => {
  // Regression failure cases: fence overhead after reopening; a line exactly
  // at the provider limit; a surrogate pair with one unit left; other fence
  // characters inside code; and syntax too wide to wrap within a small limit.
  it.each(["x".repeat(4_000), "x".repeat(8_000), "😀".repeat(4_000)])(
    "bounds fenced long lines without losing their content",
    (body) => {
      const parts = splitMessageText(`\`\`\`ts\n${body}\n\`\`\``, 4_000);
      expect(parts.every((part) => part.length <= 4_000)).toBe(true);
      expect(
        parts.map((part) => part.replace(/^```ts\n/u, "").replace(/\n```$/u, "")).join(""),
      ).toBe(body);
      expect(parts.every((part) => part.startsWith("```ts\n") && part.endsWith("\n```"))).toBe(
        true,
      );
    },
  );

  it("makes progress when a surrogate pair cannot fit the remaining room", () => {
    const parts = splitMessageText(`123456\n😀${"😀".repeat(10)}`, 8);
    expect(parts.every((part) => part.length <= 8 && part.isWellFormed())).toBe(true);
    expect(parts.join("").replaceAll("\n", "")).toBe(`123456${"😀".repeat(11)}`);
  });

  it("does not close backtick code at a tilde fence in its body", () => {
    const parts = splitMessageText(`\`\`\`ts\n~~~\n${"value\n".repeat(10)}\`\`\``, 30);
    expect(parts.every((part) => part.startsWith("```ts\n") && part.endsWith("\n```"))).toBe(true);
    expect(parts.every((part) => part.length <= 30)).toBe(true);
    expect(parts.join("\n")).toContain("~~~");
  });

  it.each([8, 9, 12, 32, 4_000])(
    "keeps a hard bound of %i even for oversized fence syntax",
    (limit) => {
      for (const text of [
        "```ts\n" + "😀".repeat(40) + "\n```",
        "```" + "language".repeat(600) + "\nx\n```",
        "~".repeat(4_100),
      ]) {
        const parts = splitMessageText(text, limit);
        expect(
          parts.every((part) => part.length > 0 && part.length <= limit && part.isWellFormed()),
        ).toBe(true);
      }
    },
  );

  it("prefers paragraph boundaries", () => {
    const text = `${"a".repeat(40)}\n\n${"b".repeat(40)}\n\n${"c".repeat(40)}`;
    expect(splitMessageText(text, 90)).toEqual([
      `${"a".repeat(40)}\n\n${"b".repeat(40)}`,
      "c".repeat(40),
    ]);
  });

  it("closes and reopens a code fence across a boundary", () => {
    const text = "```ts\n" + Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n") + "\n```";
    const parts = splitMessageText(text, 30);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.startsWith("```")).toBe(true);
      expect(part.trimEnd().endsWith("```")).toBe(true);
      expect(part.length).toBeLessThanOrEqual(30);
    }
    expect(parts.join("\n").replaceAll("```ts\n", "").replaceAll("\n```", "")).toContain("line 5");
  });

  it("cuts an overlong line at a space, never inside a surrogate pair", () => {
    const text = `${"word ".repeat(10)}😀${"x".repeat(20)}`;
    const parts = splitMessageText(text, 24);
    expect(parts.every((part) => part.length <= 24)).toBe(true);
    expect(parts.join(" ").includes("😀")).toBe(true);
    expect(parts.join("")).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("keeps every part within the limit for mixed content", () => {
    const text = [
      "# Title",
      "",
      "Some prose ".repeat(30),
      "",
      "```",
      "code ".repeat(50),
      "```",
      "",
      "- item ".repeat(40),
    ].join("\n");
    const parts = splitMessageText(text, 200);
    expect(parts.every((part) => part.length <= 200)).toBe(true);
    expect(parts.length).toBeGreaterThan(2);
  });
});
