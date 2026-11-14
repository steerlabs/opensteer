import { describe, expect, it } from "vitest";
import { teamMessage } from "./team-send.js";

const me = { userId: "usr_00000000-0000-4000-8000-000000000001", handle: "tim" };
const maya = { userId: "usr_00000000-0000-4000-8000-000000000002", handle: "maya" };
const members = new Map([
  [me.userId, me],
  [maya.userId, maya],
]);

describe("teamMessage", () => {
  it("asks your own agent by putting its handle first, once", () => {
    expect(teamMessage({ body: "check order 4411", toMyAgent: true }, me, members)).toEqual({
      bodyMarkdown: "@tim-agent check order 4411",
      mentions: [{ userId: me.userId, kind: "agent" }],
    });
    expect(
      teamMessage({ body: "@tim-agent check order 4411", toMyAgent: true }, me, members)
        .bodyMarkdown,
    ).toBe("@tim-agent check order 4411");
  });

  it("resolves people and agent handles for the Host", () => {
    const message = teamMessage(
      { body: "@maya can @maya-agent look? cc @nobody", toMyAgent: false },
      me,
      members,
    );
    expect(message.bodyMarkdown).toBe("@maya can @maya-agent look? cc @nobody");
    expect(message.mentions).toEqual([
      { userId: maya.userId, kind: "person" },
      { userId: maya.userId, kind: "agent" },
    ]);
  });

  it("sends no ask when the person did not ask their agent", () => {
    expect(teamMessage({ body: "thanks all", toMyAgent: false }, me, members).mentions).toEqual([]);
  });
});
