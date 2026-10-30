import { describe, expect, it } from "vitest";
import { routeUtterance, type VoiceNamedTarget } from "./router.js";

const targets: readonly VoiceNamedTarget[] = [
  { title: "Chat", target: { kind: "chat" } },
  { title: "Book the flights", target: { kind: "thread", threadId: "flights" } },
  { title: "Gmail — Inbox", target: { kind: "thread", threadId: "gmail" } },
  { title: "Review API documentation", target: { kind: "thread", threadId: "api" } },
  { title: "Review marketing", target: { kind: "thread", threadId: "marketing" } },
  {
    title: "Ana's iPhone",
    target: {
      kind: "place",
      destination: {
        kind: "phone",
        machineId: "mac",
        display: "main",
        computerSessionId: "session",
      },
    },
  },
];

describe("routeUtterance", () => {
  it.each([
    ["show me my Gmail task", "gmail"],
    ["GO TO THE GMAIL TAB!", "gmail"],
    ["switch to Gmail inbox", "gmail"],
    ["take me to the flights task", "flights"],
    ["bring up API documentation", "api"],
    ["pull up marketing", "marketing"],
    ["back to the flights window", "flights"],
    ["  show me, Gmail.  ", "gmail"],
  ])("routes the full request %s", (text, threadId) => {
    expect(routeUtterance(text, targets)).toEqual({ kind: "thread", threadId });
  });

  it.each(["go back", "Go back!", "go to chat", "show me chat", "switch to my chat tab"])(
    "routes %s",
    (text) => {
      expect(routeUtterance(text, targets)).toEqual({
        kind: text.toLowerCase().startsWith("go back") ? "back" : "chat",
      });
    },
  );

  it.each([
    "open a PR",
    "open Gmail",
    "show me how to use Gmail",
    "show me how to write an API",
    "show me review",
    "show me email",
    "show me the task",
    "show me",
    "go",
    "",
    "please show me Gmail",
    "can you show me Gmail",
    "show me Gmail then write a reply",
    "show me Gmail and marketing",
    "go backwards",
    "go back to where I was",
    "pull up flight",
  ])("leaves %s for Chat", (text) => {
    expect(routeUtterance(text, targets)).toBeNull();
  });

  it("refuses two places with the same normalized title and matches whole tokens", () => {
    expect(
      routeUtterance("show me Gmail", [
        ...targets,
        { title: "My Gmail page", target: { kind: "back" } },
      ]),
    ).toBeNull();
    expect(routeUtterance("go to mail", targets)).toBeNull();
    expect(routeUtterance("show me Ana's iPhone", targets)?.kind).toBe("place");
  });
});
