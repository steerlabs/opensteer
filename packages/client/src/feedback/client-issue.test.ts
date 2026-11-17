import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "../host/client.js";
import { clientIssue, presentClientIssue } from "./client-issue.js";

describe("safe client issues", () => {
  // The words come whole from the action: a stitched "{thing} {done}" read
  // "Couldn't confirm your answer sent." and "Couldn't dismiss this ask this ask."
  it("says every outcome of an action in that action's own phrases", () => {
    const words = { action: "send your answer", done: "sent", happened: "your answer was sent" };
    const say = (issue: Parameters<typeof presentClientIssue>[0]) =>
      presentClientIssue(issue).title;
    expect(say({ code: "unconfirmed", ...words })).toBe("Couldn't confirm your answer was sent.");
    expect(say({ code: "rejected", ...words })).toBe("Couldn't send your answer.");
    expect(say({ code: "rejected", reason: "forbidden", ...words })).toBe(
      "Not sent. You don't have access.",
    );
    expect(say({ code: "not-sent", reason: "offline", ...words })).toBe(
      "Not sent. You're offline.",
    );
    expect(say({ code: "unconfirmed" })).toBe("Couldn't confirm this change.");
  });
  it("never exposes upstream messages or unknown refusal details", () => {
    for (const error of [
      new Error("PRIVATE_FILE /Users/person/secret"),
      new HostClientRequestError({
        code: "forbidden",
        message: "Bearer PRIVATE_TOKEN",
        reason: "unknown-reason",
        status: 403,
      }),
    ]) {
      const issue = clientIssue(error, { operation: "action", label: "close" });
      const presented = issue && JSON.stringify(presentClientIssue(issue));
      expect(presented).not.toMatch(/PRIVATE_|unknown-reason|Users/u);
    }
  });
});
