import { describe, expect, it } from "vitest";
import {
  parseMarkdownBlock,
  parseSpans,
  splitMarkdownBlocks,
  type MarkdownSpan,
} from "./markdown-blocks.js";

/** Most table cells are a few plain words, and spelling each one out buries the shape. */
const cell = (text: string): MarkdownSpan[] => [{ kind: "text", text }];

describe("splitMarkdownBlocks", () => {
  it("splits on blank lines", () => {
    expect(splitMarkdownBlocks("One\n\nTwo\n\n\nThree")).toEqual(["One", "Two", "Three"]);
  });

  it("keeps a fenced block whole, blank lines and all", () => {
    expect(splitMarkdownBlocks("Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nEnd")).toEqual(
      ["Intro", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "End"],
    );
  });

  it("keeps the body a heading is followed by, with no blank line between them", () => {
    expect(splitMarkdownBlocks("# Result\nImportant body")).toEqual(["# Result", "Important body"]);
  });

  it("ends a heading block at the next heading", () => {
    expect(splitMarkdownBlocks("# One\n## Two\nbody")).toEqual(["# One", "## Two", "body"]);
  });

  it("ends a list at the first line that is not an item or its continuation", () => {
    expect(splitMarkdownBlocks("- first\n- second\n  wrapped\nAfterwards.")).toEqual([
      "- first\n- second\n  wrapped",
      "Afterwards.",
    ]);
  });

  it("starts a list where a paragraph runs straight into one", () => {
    expect(splitMarkdownBlocks("Steps:\n- first\n- second")).toEqual([
      "Steps:",
      "- first\n- second",
    ]);
  });

  it("keeps a whole table in one block, and a nested list in one too", () => {
    expect(splitMarkdownBlocks("| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
    ]);
    expect(splitMarkdownBlocks("- top\n  - nested\n    - deeper")).toEqual([
      "- top\n  - nested\n    - deeper",
    ]);
  });

  it("ends a table at the first line without a pipe, with no blank line between them", () => {
    expect(splitMarkdownBlocks("| a | b |\n| --- | --- |\n| 1 | 2 |\nAfterwards.")).toEqual([
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "Afterwards.",
    ]);
  });

  it("ends a table at a blank line", () => {
    expect(splitMarkdownBlocks("| a |\n| --- |\n| 1 |\n\nAfterwards.")).toEqual([
      "| a |\n| --- |\n| 1 |",
      "Afterwards.",
    ]);
  });

  it("starts a table where a paragraph runs straight into one", () => {
    expect(splitMarkdownBlocks("Results:\n| a |\n| --- |\n| 1 |")).toEqual([
      "Results:",
      "| a |\n| --- |\n| 1 |",
    ]);
  });

  it("holds a header row back until the delimiter row has streamed in", () => {
    expect(splitMarkdownBlocks("| a | b |")).toEqual(["| a | b |"]);
    expect(splitMarkdownBlocks("| a | b |\n| --- | --- |")).toEqual(["| a | b |\n| --- | --- |"]);
  });

  it("ends a fenced block at its closing fence, with no blank line after it", () => {
    expect(splitMarkdownBlocks("```ts\nconst a = 1;\n```\nAnd that is it.")).toEqual([
      "```ts\nconst a = 1;\n```",
      "And that is it.",
    ]);
  });

  it("separates a thematic break and a quote from the text around them", () => {
    expect(splitMarkdownBlocks("Before\n---\n> quoted\nAfter")).toEqual([
      "Before",
      "---",
      "> quoted",
      "After",
    ]);
  });
});

describe("parseMarkdownBlock", () => {
  it("reads a fenced code block and its language", () => {
    expect(parseMarkdownBlock("```bash\npnpm test\n```")).toEqual({
      kind: "code",
      language: "bash",
      text: "pnpm test",
    });
  });

  it("keeps an unterminated fence readable while it is still streaming", () => {
    expect(parseMarkdownBlock("```\nhalf a line")).toEqual({
      kind: "code",
      language: null,
      text: "half a line",
    });
  });

  it.each([
    ["# Title", 1],
    ["## Section", 2],
    ["#### Deep", 3],
  ])("reads %s as a level %i heading", (source, level) => {
    const block = parseMarkdownBlock(source);
    expect(block.kind).toBe("heading");
    expect(block.kind === "heading" ? block.level : null).toBe(level);
  });

  it("drops the closing hashes of an ATX heading", () => {
    expect(parseMarkdownBlock("## Section ##")).toEqual({
      kind: "heading",
      level: 2,
      spans: [{ kind: "text", text: "Section" }],
    });
  });

  it("reads bullets and numbers as one list, keeping the author's numbering", () => {
    expect(parseMarkdownBlock("- first\n- second")).toEqual({
      items: [
        { depth: 0, marker: "•", spans: [{ kind: "text", text: "first" }] },
        { depth: 0, marker: "•", spans: [{ kind: "text", text: "second" }] },
      ],
      kind: "list",
    });
    expect(parseMarkdownBlock("3. third\n4. fourth")).toEqual({
      items: [
        { depth: 0, marker: "3.", spans: [{ kind: "text", text: "third" }] },
        { depth: 0, marker: "4.", spans: [{ kind: "text", text: "fourth" }] },
      ],
      kind: "list",
    });
  });

  it("folds a wrapped list item back into the item above it", () => {
    expect(parseMarkdownBlock("- first line\n  continues here")).toEqual({
      items: [
        { depth: 0, marker: "•", spans: [{ kind: "text", text: "first line continues here" }] },
      ],
      kind: "list",
    });
  });

  it("reads a table as a header, its alignments, and its rows", () => {
    expect(parseMarkdownBlock("| Tool | Purpose |\n| --- | --- |\n| vitest | tests |")).toEqual({
      align: [null, null],
      header: [cell("Tool"), cell("Purpose")],
      kind: "table",
      rows: [[cell("vitest"), cell("tests")]],
    });
  });

  it("reads the colons of a delimiter row as alignment", () => {
    const block = parseMarkdownBlock(
      "| a | b | c | d |\n| :-- | :-: | --: | - |\n| 1 | 2 | 3 | 4 |",
    );
    expect(block.kind === "table" ? block.align : null).toEqual(["left", "center", "right", null]);
  });

  it("works without the pipes at either end, and parses cells as spans", () => {
    expect(parseMarkdownBlock("a | b\n--- | ---\n`x` | [y](https://example.test)")).toEqual({
      align: [null, null],
      header: [cell("a"), cell("b")],
      kind: "table",
      rows: [
        [
          [{ kind: "code", text: "x" }],
          [{ href: "https://example.test", kind: "link", text: "y" }],
        ],
      ],
    });
  });

  it("keeps an escaped pipe as a pipe inside its cell", () => {
    expect(parseMarkdownBlock("| a \\| b | c |\n| --- | --- |\n| d \\| e | f |")).toEqual({
      align: [null, null],
      header: [cell("a | b"), cell("c")],
      kind: "table",
      rows: [[cell("d | e"), cell("f")]],
    });
  });

  it("pads a short row and cuts a long one to the width of the header", () => {
    expect(parseMarkdownBlock("| a | b |\n| --- | --- |\n| only |\n| 1 | 2 | 3 |")).toEqual({
      align: [null, null],
      header: [cell("a"), cell("b")],
      kind: "table",
      rows: [
        [cell("only"), cell("")],
        [cell("1"), cell("2")],
      ],
    });
  });

  it("is a table with no rows yet while the body is still streaming", () => {
    expect(parseMarkdownBlock("| a | b |\n| --- | --- |")).toEqual({
      align: [null, null],
      header: [cell("a"), cell("b")],
      kind: "table",
      rows: [],
    });
  });

  it("is a paragraph when a header row has no delimiter row under it", () => {
    expect(parseMarkdownBlock("| a | b |").kind).toBe("paragraph");
    expect(parseMarkdownBlock("| a | b |\n| still prose |").kind).toBe("paragraph");
    expect(parseMarkdownBlock("| a | b |\n| --- | not dashes |").kind).toBe("paragraph");
  });

  it("reads a nested marker as an item of its own, one level deeper", () => {
    expect(parseMarkdownBlock("- top\n  - nested\n    - deeper\n- back")).toEqual({
      items: [
        { depth: 0, marker: "•", spans: [{ kind: "text", text: "top" }] },
        { depth: 1, marker: "•", spans: [{ kind: "text", text: "nested" }] },
        { depth: 2, marker: "•", spans: [{ kind: "text", text: "deeper" }] },
        { depth: 0, marker: "•", spans: [{ kind: "text", text: "back" }] },
      ],
      kind: "list",
    });
  });

  it("counts a tab as one level, and keeps the author's numbering while nesting", () => {
    expect(parseMarkdownBlock("1. one\n\t1. nested\n\t\t5. deeper")).toEqual({
      items: [
        { depth: 0, marker: "1.", spans: [{ kind: "text", text: "one" }] },
        { depth: 1, marker: "1.", spans: [{ kind: "text", text: "nested" }] },
        { depth: 2, marker: "5.", spans: [{ kind: "text", text: "deeper" }] },
      ],
      kind: "list",
    });
  });

  it("stops counting levels at three, however far the author indents", () => {
    const block = parseMarkdownBlock(
      ["- a", "  - b", "    - c", "      - d", "        - e", "              - f"].join("\n"),
    );
    expect(block.kind === "list" ? block.items.map((item) => item.depth) : null).toEqual([
      0, 1, 2, 3, 3, 3,
    ]);
  });

  it("still folds indented text into its item, and only a marker starts a new one", () => {
    expect(parseMarkdownBlock("- first line\n  continues here\n  - nested")).toEqual({
      items: [
        { depth: 0, marker: "•", spans: [{ kind: "text", text: "first line continues here" }] },
        { depth: 1, marker: "•", spans: [{ kind: "text", text: "nested" }] },
      ],
      kind: "list",
    });
  });

  it("is a paragraph when the first line is not a marker", () => {
    expect(parseMarkdownBlock("Not a list\n- but this is").kind).toBe("paragraph");
  });

  it("reads a rule and a quote", () => {
    expect(parseMarkdownBlock("---")).toEqual({ kind: "rule" });
    expect(parseMarkdownBlock("> quoted\n> lines")).toEqual({
      kind: "quote",
      spans: [{ kind: "text", text: "quoted lines" }],
    });
  });
});

describe("parseSpans", () => {
  it.each([
    "com.opensteer.mobile:/deployments/another",
    "javascript:alert",
    "file:///private/file",
    "tel:123456",
    "sms:123456",
    "/relative/path",
    "data:text/plain,hello",
  ])("renders non-document links as text: %s", (href) => {
    expect(parseSpans(`[Read this](${href})`)).toEqual([{ kind: "text", text: "Read this" }]);
  });

  it.each(["https://example.test", "http://example.test", "mailto:help@example.test"])(
    "preserves readable links: %s",
    (href) => {
      expect(parseSpans(`[Read this](${href})`)).toEqual([
        { kind: "link", href, text: "Read this" },
      ]);
    },
  );

  it("reads code, links, and emphasis", () => {
    expect(parseSpans("Run `pnpm test` in [the repo](https://example.test) **now**")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: " in " },
      { href: "https://example.test", kind: "link", text: "the repo" },
      { kind: "text", text: " " },
      { kind: "emphasis", strong: true, text: "now" },
    ]);
  });

  it("leaves markers inside a code span alone", () => {
    expect(parseSpans("`a ** b [c](d)`")).toEqual([{ kind: "code", text: "a ** b [c](d)" }]);
  });

  it("links a bare URL and strips the angle brackets an author may add", () => {
    expect(parseSpans("see <https://example.test/a>")).toEqual([
      { kind: "text", text: "see " },
      { href: "https://example.test/a", kind: "link", text: "https://example.test/a" },
    ]);
  });
});
