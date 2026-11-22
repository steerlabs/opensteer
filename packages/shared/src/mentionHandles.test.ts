import { describe, expect, it } from "vitest";
import { mentionHandles } from "./mentionHandles.js";

describe("Markdown mention handles", () => {
  it("reads ordinary handles", () => {
    expect(mentionHandles("@tim-agent help @tim, me@tim")).toEqual(["tim-agent", "tim"]);
  });
  it("ignores complete links, images, definitions, code, HTML and source escapes", () => {
    const source = [
      "[see @tim-agent](https://example.com/c/abc)",
      "![ @tim-agent](/tmp/a.png)",
      "[x][ref]",
      "[ref]: <opensteer: @tim-agent>",
      "` @tim-agent`",
      "```\n@tim-agent\n```",
      '<span title=" @tim-agent"> @tim-agent</span>',
      "\\@tim-agent",
      "&#64;tim-agent",
    ].join("\n\n");
    expect(mentionHandles(source)).toEqual([]);
  });
});
