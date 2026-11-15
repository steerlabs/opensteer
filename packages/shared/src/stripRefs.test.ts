import { describe, expect, it } from "vitest";
import { stripRefs } from "./stripRefs.js";
import { teamMentionHandles } from "./teamMentions.js";

const href = "opensteer:thr_12345678-1234-4234-8234-123456789abc";
describe("stripRefs", () => {
  it.each([
    ["Before [**result**](" + href + ") after.", "Before **result** after."],
    ["[future](OPENSTEER:future_kind?private)", "future"],
    ["[malformed](opensteer://bad)", "malformed"],
    ["[a\\]b](<" + href + '> "title")', "a\\]b"],
    ["![chart](/tmp/a.png)", "chart"],
    ["![chart](./a.png)", "chart"],
    ["[file](file:///tmp/private)", "file"],
    ["[file](//host/private)", "file"],
    ["[file](%2f%2fhost/private)", "file"],
    ["[file](<C:\\work\\a.txt>)", "file"],
    ["<" + href + ">", "Opensteer item"],
    ["<file:///tmp/private>", "File"],
    ["before [unfinished](" + href, "before "],
    ["[ref]: <opensteer:future", ""],
    ["[one][ref] / [ref][] / [ref]\n\n[ref]: " + href + "\n", "one / ref / ref\n\n\n"],
    [
      "[public][ref]\n\n[ref]: https://team.example/c/abc\n[ref]: " + href,
      "[public][ref]\n\n[ref]: https://team.example/c/abc\n",
    ],
    ["![alt][ref]\n\n[ref]: /tmp/private.png", "alt\n\n"],
  ])("sanitizes source and stays idempotent: %s", (source, expected) => {
    expect(stripRefs(source)).toBe(expected);
    expect(stripRefs(stripRefs(source))).toBe(expected);
  });

  it("retains the legacy bridge local/network image policy", () => {
    const text =
      "![chart](</tmp/a%20b.png>) ![ref][img] `![](/tmp/a.png)` ![web](https://example.com/a.png)\n\n[img]: file:///tmp/b.png";
    expect(stripRefs(text)).toBe(
      "chart ref `![](/tmp/a.png)` ![web](https://example.com/a.png)\n\n",
    );
    for (const path of [
      "~/a.png",
      "../a.png",
      "file://host/a.png",
      String.raw`\\host\a.png`,
      "%2F%2Fhost/a.png",
    ]) {
      expect(stripRefs(`![alt](<${path}>)`)).toBe("alt");
    }
  });

  it("preserves unrelated Markdown and code exactly", () => {
    const source =
      "# Heading\n\n[team](https://team.example/c/a) [web](https://example.test) ![remote](https://example.test/image.png)\n\n`[literal](" +
      href +
      ")`\n\n```md\n[x](/tmp/file)\n```\n\n\\[escaped](" +
      href +
      ")";
    expect(stripRefs(source)).toBe(source);
  });

  it("never adds handles inside labels or across replacement and definition boundaries", () => {
    for (const source of [
      "[word ](" + href + ")@tim-agent",
      "[see @tim-agent](" + href + ")",
      "[x](" + href + ")\n\n[ref]: " + href + "\n@tim-agent",
      "[web @tim-agent](https://team.example/c/x) [see @other-agent](" + href + ")",
      "@tim-agent [see @tim-agent](" + href + ")",
    ]) {
      const original = new Set(teamMentionHandles(source));
      const result = stripRefs(source);
      expect(teamMentionHandles(result).every((handle) => original.has(handle))).toBe(true);
      expect(stripRefs(result)).toBe(result);
    }
    expect(stripRefs("[word ](" + href + ")@tim-agent")).toBe("word \\@tim-agent");
  });
});
