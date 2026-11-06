import type { PhrasingContent, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { replyParts, splitMarkdownBlocks } from "./markdown.js";
import { parseMarkdown } from "./markdownParser.js";

/** The tree as short tagged text, so a case reads as what a person sees. */
function drawn(nodes: readonly (RootContent | PhrasingContent)[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.value;
        case "strong":
          return `<b>${drawn(node.children)}</b>`;
        case "emphasis":
          return `<i>${drawn(node.children)}</i>`;
        case "inlineCode":
          return `<c>${node.value}</c>`;
        case "link":
          return `<a>${drawn(node.children)}</a>`;
        case "paragraph":
        case "heading":
        case "listItem":
        case "list":
        case "blockquote":
          return `${drawn(node.children)}|`;
        case "code":
          return `<pre>${node.value}</pre>`;
        default:
          return `<${node.type}>`;
      }
    })
    .join("");
}

const parsed = (text: string, streaming = false): string =>
  drawn(parseMarkdown(text, { streaming }).children).replaceAll("|", "");

describe("bold an agent wrote", () => {
  it.each([
    ["**Note:**next word", "<b>Note:</b>next word"],
    ["**Summary (draft)**next", "<b>Summary (draft)</b>next"],
    ['**"quoted"**word', '<b>"quoted"</b>word'],
    ['word**"quoted"**', 'word<b>"quoted"</b>'],
    ["**重要：**这是中文", "<b>重要：</b>这是中文"],
    ["**`code`**text", "<b><c>code</c></b>text"],
    ["**[docs](https://a.co/x)**next", "<b><a>docs</a></b>next"],
    ["**a:**b and **c:**d", "<b>a:</b>b and <b>c:</b>d"],
    ["# **Head:**ing", "<b>Head:</b>ing"],
  ])("draws %s as bold, which CommonMark alone leaves literal", (text, expected) => {
    expect(parsed(text)).toBe(expected);
  });

  it.each([
    ["2 ** 3 ** 4", "2 ** 3 ** 4"],
    ["**kwargs and **args stay", "**kwargs and **args stay"],
    ["**spaced ** text", "**spaced ** text"],
    ["** spaced** text", "** spaced** text"],
    ["`**not bold:**x` stays code", "<c>**not bold:**x</c> stays code"],
    ["\\*\\*not bold:\\*\\*x", "**not bold:**x"],
    ["This is **unfinished", "This is **unfinished"],
  ])("leaves %s as the author wrote it", (text, expected) => {
    expect(parsed(text)).toBe(expected);
  });

  it("leaves bold CommonMark already reads to CommonMark", () => {
    expect(parsed("**Bold** and **run `pnpm dev` now**")).toBe(
      "<b>Bold</b> and <b>run <c>pnpm dev</c> now</b>",
    );
    expect(parsed("***both***")).toBe("<i><b>both</b></i>");
  });

  it("does not reach into a code fence", () => {
    expect(parsed("```\n**Note:**next\n```")).toBe("<pre>**Note:**next</pre>");
  });
});

describe("bold while it streams", () => {
  it.each([
    ["This is **partial", "This is <b>partial</b>"],
    ["**a** and **b", "<b>a</b> and <b>b</b>"],
    ["one\n\nLast **open", "oneLast <b>open</b>"],
    ["Done **", "Done "],
  ])("draws %s with no stray markers", (text, expected) => {
    expect(parsed(text, true)).toBe(expected);
  });

  it("only touches the tail, so a finished paragraph above keeps its words", () => {
    expect(parsed("a **b\n\nc", true)).toBe("a **bc");
  });
});

describe("splitMarkdownBlocks", () => {
  const whole = (text: string): string => drawn(parseMarkdown(text).children);
  const pieces = (text: string): string =>
    splitMarkdownBlocks(text)
      .map((block) => whole(block))
      .join("");

  it("cuts at the blank lines that close every open block", () => {
    expect(splitMarkdownBlocks("one\n\ntwo")).toEqual(["one\n\n", "two"]);
  });

  it("keeps a fence whole, blank lines and all", () => {
    expect(splitMarkdownBlocks("```\na\n\nb\n```\n\nnext")).toEqual([
      "```\na\n\nb\n```\n\n",
      "next",
    ]);
  });

  it("keeps what continues a list with the list, however it is indented", () => {
    const list = "1. **First**\n\n    Details **bold** here";
    expect(splitMarkdownBlocks(list)).toEqual([list]);
    expect(parsed(list)).toBe("<b>First</b>Details <b>bold</b> here");
  });

  it("only cuts where the pieces draw what the whole does, at every prefix of a reply", () => {
    const reply =
      "Intro **bold** text.\n\n1. **First**\n\n    Details here\n\n    ```bash\n    pnpm dev\n\n    pnpm test\n    ```\n\n2. Second\n\n- a\n\n- b\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nEnd.";
    for (let end = 1; end <= reply.length; end += 1) {
      const prefix = reply.slice(0, end);
      expect(pieces(prefix), prefix).toBe(whole(prefix));
    }
  });

  it("does not cut text whose syntax ties its blocks together", () => {
    const linked = "[ref][1]\n\n[1]: https://a.co";
    expect(splitMarkdownBlocks(linked)).toEqual([linked]);
  });
});

describe("replyParts", () => {
  it("is one bubble for a reply of plain words", () => {
    expect(replyParts("Fixed.\n\nIt restarted.")).toEqual([
      { kind: "prose", text: "Fixed.\n\nIt restarted.", wide: false },
    ]);
  });

  it("gives code and drafts bubbles of their own, in order", () => {
    expect(
      replyParts(
        "Run:\n\n```bash\npnpm dev\n\npnpm test\n```\nThen send:\n\n```draft\nHeads up.\n```",
      ),
    ).toEqual([
      { kind: "prose", text: "Run:", wide: false },
      {
        kind: "code",
        language: "bash",
        source: "```bash\npnpm dev\n\npnpm test\n```",
        text: "pnpm dev\n\npnpm test",
      },
      { kind: "prose", text: "Then send:", wide: false },
      { kind: "draft", text: "Heads up." },
    ]);
  });

  it("leaves a fence inside a list where the list put it, and draws that bubble wide", () => {
    const steps = "1. Step\n   ```bash\n   pnpm dev\n   ```\n2. Next";
    expect(replyParts(steps)).toEqual([{ kind: "prose", text: steps, wide: true }]);
  });

  it("does not read the closer of a fence held in the words as a new opener", () => {
    const steps = " ```bash\nls\n```\nDone.";
    expect(replyParts(steps)).toEqual([{ kind: "prose", text: steps, wide: true }]);
  });

  it("draws a table's bubble wide", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(replyParts(table)).toEqual([{ kind: "prose", text: table, wide: true }]);
  });

  it("keeps a fence's words verbatim when a longer fence holds a shorter one", () => {
    expect(replyParts("````md\n```\nnot closed\n```\n````")[0]).toMatchObject({
      kind: "code",
      text: "```\nnot closed\n```",
    });
  });

  it("does not split text whose syntax ties its blocks together", () => {
    const linked = "[ref][1]\n\n```\ncode\n```\n\n[1]: https://a.co";
    expect(replyParts(linked)).toEqual([{ kind: "prose", text: linked, wide: true }]);
  });

  it("keeps the indent that makes a reply's first line code", () => {
    const indented = "    echo one\n    echo two";
    expect(replyParts(`\n${indented}\n\n`)).toEqual([
      { kind: "prose", text: indented, wide: false },
    ]);
    expect(parsed(indented)).toBe("<pre>echo one\necho two</pre>");
  });

  it("does not close a fence at a line indented past what can close one", () => {
    const parts = replyParts("```text\n    ```\nstill code\n```");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: "code", text: "    ```\nstill code" });
  });

  it("has nothing to draw for an empty reply", () => {
    expect(replyParts("  \n")).toEqual([]);
  });
});

describe("parseMarkdown", () => {
  it("takes a label's first definition, as web does", () => {
    const tree = parseMarkdown("[docs][ref]\n\n[ref]: https://a.co\n[ref]: https://b.co");
    expect(tree.children[0]).toMatchObject({ children: [{ url: "https://a.co" }] });
  });

  it("resolves a reference to the link or image it names", () => {
    const tree = parseMarkdown(
      "[docs][ref] and ![chart][img]\n\n[ref]: https://a.co\n[img]: b.png",
    );
    expect(tree.children[0]).toMatchObject({
      children: [
        { children: [{ value: "docs" }], type: "link", url: "https://a.co" },
        { value: " and " },
        { alt: "chart", type: "image", url: "b.png" },
      ],
    });
  });
});
