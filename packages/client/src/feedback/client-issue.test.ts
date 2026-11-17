import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "../host/client.js";
import { clientIssue, presentClientIssue } from "./client-issue.js";

describe("safe client issues", () => {
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
