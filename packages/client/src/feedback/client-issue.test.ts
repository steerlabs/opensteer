import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "../host/client.js";
import {
  clientIssue,
  presentClientIssue,
  presentConnectionDetail,
  presentConnectionGate,
  presentMessageDelivery,
  type ClientIssue,
  type ClientIssueCode,
} from "./client-issue.js";
import type { ClientConnectionState } from "../connections/connection-controller.js";

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
  // "Not sent. your computer didn't accept it." and "your computer needs an update"
  // started sentences in lowercase when the computer had no name to say.
  it("starts every sentence with a capital, with or without a name", () => {
    const codes: readonly ClientIssueCode[] = [
      "connection",
      "sign-in",
      "update-app",
      "update-server",
      "web-outdated",
      "access-lost",
      "open-failed",
      "read-failed",
      "refresh-failed",
      "not-sent",
      "unconfirmed",
      "rejected",
      "login-storage-unavailable",
      "storage-unavailable",
      "queue-full",
      "preparation-required",
    ];
    const said: string[] = [];
    for (const name of [undefined, "Mac mini"])
      for (const target of ["computer", "team"] as const)
        for (const code of codes)
          for (const reason of [undefined, "offline", "unreachable"]) {
            const issue: ClientIssue = {
              code,
              target,
              ...(name ? { name } : {}),
              ...(reason ? { reason } : {}),
            };
            const state = {
              issue,
              name: name ?? null,
              target,
              showInterruption: true,
            } as ClientConnectionState;
            for (const words of [
              presentClientIssue(issue),
              presentConnectionDetail(issue),
              presentConnectionGate(state),
            ])
              said.push(words.title, ...(words.detail ? [words.detail] : []));
            said.push(presentMessageDelivery("rejected", issue));
          }
    const lowercase = said.filter((words) =>
      words.split(/(?<=[.?!]) /u).some((sentence) => /^[a-z]/u.test(sentence)),
    );
    expect(lowercase).toEqual([]);
  });
  it("names the computer a refused message went to", () => {
    expect(presentMessageDelivery("rejected", { code: "rejected" }, "Mac mini")).toBe(
      "Not sent. Mac mini didn't accept it.",
    );
    expect(presentMessageDelivery("rejected", { code: "rejected" })).toBe(
      "Not sent. Your computer didn't accept it.",
    );
  });
});
