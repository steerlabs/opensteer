import { describe, expect, it } from "vitest";
import { collectComposerTokens, replaceComposerRange, snapComposerSelection } from "./composer.js";
const link = "[task](opensteer:thr_12345678-1234-4234-8234-123456789abc)";

describe("composer source tokens", () => {
  it("uses UTF-16 source offsets and preserves exact escaped source", () => {
    const source = "🦊 before [a\\]b](opensteer:thr_12345678-1234-4234-8234-123456789abc) after";
    const [token] = collectComposerTokens(source);
    expect(token).toMatchObject({
      start: 10,
      end: source.indexOf(" after"),
      label: "a]b",
      kind: "personal",
    });
    expect(source.slice(token!.start, token!.end)).toBe(token!.source);
    expect(source.slice(0, token!.start) + token!.source + source.slice(token!.end)).toBe(source);
  });
  it("ignores escaped brackets, images, code fences, inline code, definitions and HTML", () => {
    const text =
      "\\" +
      link +
      "\n\n!" +
      link +
      "\n\n`" +
      link +
      "`\n\n```md\n" +
      link +
      "\n```\n\n[ref]: opensteer:thr_12345678-1234-4234-8234-123456789abc\n\n<pre>\n" +
      link +
      "\n</pre>";
    expect(collectComposerTokens(text, { commitTrailing: true })).toEqual([]);
  });
  it("commits completed trailing links explicitly and retains committed atoms after delimiter removal", () => {
    expect(collectComposerTokens(link)).toEqual([]);
    const tokens = collectComposerTokens(link + " ");
    expect(tokens).toHaveLength(1);
    expect(collectComposerTokens(link, { previous: tokens })).toEqual(tokens);
    expect(collectComposerTokens(link, { commitTrailing: true })).toEqual(tokens);
    expect(
      collectComposerTokens(link.slice(0, -1), { previous: tokens, commitTrailing: true }),
    ).toEqual([]);
  });

  it("snaps caret motion and atomically replaces partially selected destinations", () => {
    const text = "🦊 " + link + " end";
    const tokens = collectComposerTokens(text);
    expect(snapComposerSelection(text, { start: 4, end: 4 }, tokens)).toEqual({ start: 3, end: 3 });
    const end = tokens[0]!.end;
    expect(snapComposerSelection(text, { start: end - 1, end: end - 1 }, tokens)).toEqual({
      start: end,
      end,
    });
    expect(replaceComposerRange(text, { start: 4, end: 9 }, "next", tokens)).toEqual({
      text: "🦊 next end",
      selection: { start: 7, end: 7 },
    });
    expect(replaceComposerRange(text, { start: end - 1, end }, "", tokens).text).toBe("🦊  end");
  });
});
