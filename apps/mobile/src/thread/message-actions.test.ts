import { describe, expect, it } from "vitest";
import { messageActions } from "./message-actions.js";

const titles = (options: Parameters<typeof messageActions>[0]): readonly string[] =>
  messageActions(options).map(({ title }) => title);

describe("what holding a message offers", () => {
  it("offers a person's own bubble only what they can do with their words", () => {
    expect(titles({})).toEqual(["Copy", "Select", "Share…"]);
  });

  it("offers a reply Reply first and Run Details last, in groups of their own", () => {
    const actions = messageActions({ onActivity: () => undefined, onReply: () => undefined });
    expect(actions.map(({ group, title }) => [group, title])).toEqual([
      [0, "Reply"],
      [1, "Copy"],
      [1, "Select"],
      [1, "Share…"],
      [2, "Run Details"],
    ]);
  });

  it("offers the whole of a reply drawn as several bubbles, beside the one held", () => {
    expect(titles({ whole: "All of it" })).toEqual([
      "Copy",
      "Copy Whole Reply",
      "Select",
      "Share…",
    ]);
  });

  it("keeps Reply and Run Details on a reply with no words to copy", () => {
    expect(
      titles({ onActivity: () => undefined, onReply: () => undefined, worded: false }),
    ).toEqual(["Reply", "Run Details"]);
  });

  it("names a code bubble's copy, and has nothing to select in it", () => {
    expect(titles({ code: true })).toEqual(["Copy Code", "Share…"]);
  });
});
