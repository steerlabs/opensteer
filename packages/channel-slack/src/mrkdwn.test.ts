import { describe, expect, it } from "vitest";
import { renderSlackDeliveryText, renderSlackMrkdwn } from "./mrkdwn.js";
import { delivery } from "./test-fixtures.js";

describe("renderSlackMrkdwn", () => {
  it("converts Markdown emphasis to the single-character mrkdwn forms", () => {
    expect(renderSlackMrkdwn("**bold** and __also bold__")).toBe("*bold* and *also bold*");
    expect(renderSlackMrkdwn("*italic* and _italic_")).toBe("_italic_ and _italic_");
    expect(renderSlackMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("does not read its own bold output back as italic", () => {
    expect(renderSlackMrkdwn("**one** *two*")).toBe("*one* _two_");
  });

  it("renders headings as bold lines, because mrkdwn has no headings", () => {
    expect(renderSlackMrkdwn("# Title\ntext")).toBe("*Title*\ntext");
    expect(renderSlackMrkdwn("### Deeper **still**")).toBe("*Deeper still*");
  });

  it("rewrites links into the angle-bracket form", () => {
    expect(renderSlackMrkdwn("see [the thread](https://example.test/t/1)")).toBe(
      "see <https://example.test/t/1|the thread>",
    );
    expect(renderSlackMrkdwn("[](https://example.test)")).toBe("<https://example.test>");
  });

  it("turns bullets into • and keeps numbered lists", () => {
    expect(renderSlackMrkdwn("- one\n* two\n+ three")).toBe("• one\n• two\n• three");
    expect(renderSlackMrkdwn("1. first\n2) second")).toBe("1. first\n2) second");
  });

  it("escapes only the three characters Slack reads as markup, and not inside code", () => {
    expect(renderSlackMrkdwn("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(renderSlackMrkdwn("use `a < b` here")).toBe("use `a < b` here");
    expect(renderSlackMrkdwn("```\nif (a < b) { }\n```")).toBe("```\nif (a < b) { }\n```");
  });

  it("keeps quotes and fenced code, and wraps tables in a fence", () => {
    expect(renderSlackMrkdwn("> quoted **thing**")).toBe("> quoted *thing*");
    expect(renderSlackMrkdwn("| a | b |\n| - | - |\n| 1 | 2 |")).toBe(
      "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```",
    );
  });
});

describe("renderSlackDeliveryText", () => {
  it("renders the text parts and leaves artifact parts to the Host's own line", () => {
    expect(
      renderSlackDeliveryText(
        delivery({
          content: [
            { text: "**done**", type: "text" },
            { artifactId: "a1", mediaType: "text/plain", name: "notes.txt", type: "artifact" },
          ],
        }),
      ),
    ).toBe("*done*");
  });

  it("never posts an empty message", () => {
    expect(
      renderSlackDeliveryText(
        delivery({
          content: [
            { artifactId: "a1", mediaType: "text/plain", name: "notes.txt", type: "artifact" },
          ],
        }),
      ),
    ).toBe("(No text content)");
  });
});
