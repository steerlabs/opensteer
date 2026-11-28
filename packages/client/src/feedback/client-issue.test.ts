import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "../host/client.js";
import {
  browserPoolRefusalWords,
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
  it("offers Account sign-in for a lost Account and no retry for unavailable credential storage", () => {
    const say = (issue: ClientIssue) =>
      presentConnectionGate({
        issue,
        name: "Mac mini",
        showInterruption: true,
      } as ClientConnectionState);
    expect(say({ code: "sign-in", reason: "account-required" })).toEqual({
      title: "Sign in to your Opensteer account",
      detail: "Use the Account linked to Mac mini.",
      action: "sign-in",
    });
    expect(say({ code: "login-storage-unavailable" })).toEqual({
      title: "Couldn't access sign-in storage on this device.",
      detail: null,
      action: null,
    });
  });

  it.each([
    ["device-offline", "Open Opensteer on the device and keep it open, then try again."],
    [
      "computer-app-connecting",
      "Opensteer on the device is still connecting. Try again in a moment.",
    ],
    [
      "computer-app-not-offered",
      "This device doesn't offer the app. Check for an Opensteer update on the device.",
    ],
    [
      "computer-app-approval-changed",
      "This request changed or is no longer waiting. Review the current access.",
    ],
    [
      "computer-app-definition-changed",
      "The app or its available access changed. Review it and request access again.",
    ],
    [
      "computer-app-installation-invalid",
      "The Host couldn't read this app's installation. Check for an Opensteer update on the Host.",
    ],
  ])("explains a computer app refusal (%s)", (reason, detail) => {
    const error = new HostClientRequestError({
      code: "conflict",
      message: "Unfiltered Host message",
      reason,
      status: 409,
    });
    const issue = clientIssue(error, { operation: "action", label: "answer this request" });
    expect(issue).toMatchObject({ code: "rejected", reason });
    expect(presentClientIssue({ ...issue!, done: "answered" }).title).toBe(
      `Not answered. ${detail}`,
    );
  });
  it.each([
    [
      "bridge-anyone-grant",
      "When anyone in the conversation can message it, it can use only tasks and the plugins you choose.",
    ],
    [
      "bridge-needs-tasks",
      "A chat can only ask your own agents to work, so it always needs tasks.",
    ],
  ])("says a chat's grant refusal in the Home's words (%s)", (reason, detail) => {
    const error = new HostClientRequestError({
      code: "bad_request",
      message: "Unfiltered Host message",
      reason,
      status: 400,
    });
    const issue = clientIssue(error, { operation: "action", label: "save this change" });
    expect(presentClientIssue({ ...issue!, done: "saved" }).title).toBe(`Not saved. ${detail}`);
  });
  it("distinguishes slow connecting, recovering, same-computer unreachable, remote unreachable, and offline", () => {
    const base: ClientConnectionState = {
      epoch: 1,
      issue: null,
      lastConnectedAt: null,
      name: "Mac mini",
      network: "online",
      pathRevision: 0,
      phase: "connecting",
      readyRevision: 0,
      route: "connect",
      scope: null,
      showInterruption: true,
      target: "computer",
      trying: true,
      visibility: "foreground",
    };

    // Unanswered initial attempt past the quiet hold: honest progress, no Retry button.
    expect(
      presentConnectionGate({
        ...base,
        phase: "connecting",
        route: "same-computer",
        issue: { code: "connection", reason: "reconnecting", route: "same-computer" },
      }),
    ).toEqual({
      title: "Connecting to Mac mini…",
      detail: "Opensteer on this computer is taking longer than usual to respond.",
      action: null,
    });
    expect(
      presentConnectionGate({
        ...base,
        phase: "connecting",
        route: "connect",
        issue: { code: "connection", reason: "reconnecting", route: "connect" },
      }),
    ).toEqual({
      title: "Connecting to Mac mini…",
      detail: "This is taking longer than usual.",
      action: null,
    });

    // Automatic recovery without an observed unreachable failure: honest reconnecting, no Retry button.
    expect(
      presentConnectionGate({
        ...base,
        phase: "recovering",
        route: "same-computer",
        trying: false,
        issue: { code: "connection", reason: "reconnecting", route: "same-computer" },
      }),
    ).toEqual({
      title: "Reconnecting…",
      detail: "Opensteer on this computer is reconnecting on its own.",
      action: null,
    });

    // Observed unreachable failure on same-computer never blames internet connectivity.
    const localUnreachable = presentConnectionGate({
      ...base,
      phase: "recovering",
      route: "same-computer",
      trying: false,
      issue: { code: "connection", reason: "unreachable", route: "same-computer" },
    });
    expect(localUnreachable).toEqual({
      title: "Opensteer isn't responding",
      detail: "Opensteer on this computer isn't responding right now.",
      action: "retry",
    });
    expect(JSON.stringify(localUnreachable).toLowerCase()).not.toContain("internet");

    // Observed unreachable on a remote computer keeps the remote copy and offers retry.
    expect(
      presentConnectionGate({
        ...base,
        phase: "recovering",
        route: "connect",
        trying: false,
        issue: { code: "connection", reason: "unreachable", route: "connect" },
      }),
    ).toEqual({
      title: "Can't reach Mac mini",
      detail: "Make sure it's on and connected to the internet.",
      action: "retry",
    });

    // Offline stays honest with no retry button.
    expect(
      presentConnectionGate({
        ...base,
        phase: "recovering",
        network: "offline",
        trying: false,
        issue: { code: "connection", reason: "offline" },
      }),
    ).toEqual({
      title: "You're offline",
      detail: "Your tasks will show up when you're back online.",
      action: null,
    });

    // Pill and details reflect same-computer route without blaming the internet.
    expect(
      presentClientIssue({
        code: "connection",
        reason: "unreachable",
        name: "Mac mini",
        route: "same-computer",
      }),
    ).toEqual({
      title: "Opensteer isn't responding",
      detail: null,
      action: "retry",
    });
    expect(
      presentConnectionDetail({
        code: "connection",
        reason: "unreachable",
        name: "Mac mini",
        route: "same-computer",
      }),
    ).toEqual({
      title: "Opensteer isn't responding",
      detail: "Opensteer on this computer isn't responding right now. Opensteer keeps trying.",
      action: "retry",
    });
    expect(
      presentConnectionDetail({
        code: "connection",
        reason: "reconnecting",
        name: "Mac mini",
        route: "same-computer",
      }),
    ).toEqual({
      title: "Reconnecting…",
      detail: "Opensteer on this computer is reconnecting on its own.",
      action: null,
    });
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
      "draft-unsaved",
      "storage-unavailable",
      "queue-full",
      "preparation-required",
    ];
    const said: string[] = [];
    for (const name of [undefined, "Mac mini"])
      for (const target of ["computer"] as const)
        for (const route of [undefined, "same-computer", "connect"] as const)
          for (const code of codes)
            for (const reason of [undefined, "offline", "reconnecting", "unreachable"]) {
              const issue: ClientIssue = {
                code,
                target,
                ...(name ? { name } : {}),
                ...(reason ? { reason } : {}),
                ...(route ? { route } : {}),
              };
              for (const phase of ["connecting", "recovering"] as const) {
                const state = {
                  issue,
                  name: name ?? null,
                  phase,
                  route: route ?? null,
                  target,
                  showInterruption: true,
                } as ClientConnectionState;
                said.push(
                  presentConnectionGate(state).title,
                  ...(presentConnectionGate(state).detail
                    ? [presentConnectionGate(state).detail!]
                    : []),
                );
              }
              for (const words of [presentClientIssue(issue), presentConnectionDetail(issue)])
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

  it("presents outcome-unknown Host conflicts as unconfirmed rather than a definite rejection (M8)", () => {
    const issue = clientIssue(
      { code: "conflict", reason: "outcome-unknown", retryable: false },
      { operation: "action", label: "send your answer" },
    );
    expect(issue).toEqual({ code: "unconfirmed", action: "send your answer" });
    expect(presentClientIssue({ ...issue!, happened: "your answer was sent" })).toMatchObject({
      title: "Couldn't confirm your answer was sent.",
      action: "check",
    });
  });

  it.each([
    [
      "browser-pool-refused",
      "Your Cloud Computer’s browser can’t start right now. Your tabs and sign-ins are kept.",
    ],
    [
      "browser-pool-start-refused",
      "Your Cloud Computer’s browser can’t start right now. Try again in a moment.",
    ],
    ["browser-pool-setting-up", "Setting up your browser… This can take a few minutes."],
    [
      "browser-pool-unreachable",
      "Your Cloud Computer’s browser couldn’t be reached. Try again in a moment.",
    ],
    [
      "browser-pool-disconnected",
      "Your Cloud Computer’s browser isn’t connected right now. Try again in a moment.",
    ],
  ])(
    "words Cloud Computer pooled-browser refusal (%s) without exposing raw messages",
    (reason, words) => {
      expect(browserPoolRefusalWords(reason)).toBe(words);
      const error = new HostClientRequestError({
        code: "conflict",
        message: "INTERNAL_UNFILTERED_MESSAGE",
        reason,
        status: 409,
      });
      const issue = clientIssue(error, { operation: "action", label: "open this" });
      expect(issue).toMatchObject({ code: "rejected", reason });
      expect(presentClientIssue({ ...issue!, done: "opened" }).title).toBe(`Not opened. ${words}`);
      expect(browserPoolRefusalWords("browser-placement-unavailable")).toBeUndefined();
      expect(browserPoolRefusalWords(undefined)).toBeUndefined();
    },
  );

  it("words a cloud-tab typing overload stop as a single standalone sentence", () => {
    expect(
      presentClientIssue({
        code: "rejected",
        action: "send that to the page",
        done: "sent",
        reason: "browser-typing-overload",
      }),
    ).toEqual({
      title: "Typing stopped. Some of it may not have arrived: check the text.",
      detail: null,
      action: null,
    });
  });
});
