import { describe, expect, it } from "vitest";
import { teamMessage, teamMentionHandles, teamMentions } from "./teamMentions.js";

const me = { userId: "tim-id", handle: "tim" };
const members = new Map([["tim", me]]);
describe("Markdown mention authority", () => {
  it("retains ordinary people and explicit agent asks", () => {
    expect(teamMentionHandles("@tim-agent help @tim, me@tim")).toEqual(["tim-agent", "tim"]);
    expect(teamMentions("Please @tim-agent help", [me])).toEqual([
      { userId: me.userId, kind: "agent" },
    ]);
  });
  it("ignores complete links, images, definitions, code, HTML and source escapes", () => {
    const source = [
      "[see @tim-agent](https://team.example/c/abc)",
      "![ @tim-agent](/tmp/a.png)",
      "[x][ref]",
      "[ref]: <opensteer: @tim-agent>",
      "` @tim-agent`",
      "```\n@tim-agent\n```",
      '<span title=" @tim-agent"> @tim-agent</span>',
      "\\@tim-agent",
      "&#64;tim-agent",
    ].join("\n\n");
    expect(teamMentionHandles(source)).toEqual([]);
  });
  it("adds a real own-agent ask when a handle is only hidden in Markdown", () => {
    const body = "[see @tim-agent](https://team.example/c/abc)";
    expect(teamMessage({ body, toMyAgent: true }, me, members)).toEqual({
      bodyMarkdown: "@tim-agent " + body,
      mentions: [{ userId: me.userId, kind: "agent" }],
    });
    expect(
      teamMessage({ body: "@tim-agent help", toMyAgent: true }, me, members).bodyMarkdown,
    ).toBe("@tim-agent help");
  });
});
