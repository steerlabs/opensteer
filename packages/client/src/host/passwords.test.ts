import { createId, RunnerIdSchema, type AgentEvent, type Request } from "@opensteer/core";
import type { PasswordSignInRequestResponse } from "@opensteer/protocol";
import type { DesktopPasswordsStatus } from "@opensteer/protocol/desktop";
import { describe, expect, it } from "vitest";
import {
  browserSignInStep,
  passwordSignInAccountList,
  passwordSignInConsent,
  passwordSignInAllowRemembers,
  passwordSignInExpiry,
  passwordSignInNoAccount,
  passwordSignInNoAccountMatch,
  passwordSignInOtherAccounts,
  passwordSignInOutcome,
  passwordSignInPrivacy,
  passwordSignInReceipt,
  passwordSignInWaitingOn,
  passwordsElsewhere,
  passwordsHere,
  passwordsSettingsState,
  passwordsSettingsSubtitle,
  passwordsWaitingDetail,
  type PasswordSignInAccount,
} from "./passwords.js";
import { foldTranscriptEvent } from "./transcript.js";

/*
 * How the shared words and decisions could mislead the person:
 * - a sign-in outcome has no words, or the wrong ones (every response variant,
 *   including a failure reason added later, must say what happened);
 * - the site is named by its full URL instead of its domain;
 * - a Mac other than the one in front of the reader is called "this Mac", or
 *   the one in front of them is called by name in the one place it should not;
 * - a plain browser tab on the approving Mac, or the desktop app on another
 *   computer, is treated as the approving Mac and offers its controls;
 * - the privacy line names "this website" instead of the site, or promises
 *   only "your agent" when no agent ever sees the password;
 * - the desktop app on the Mac that runs this Personal Opensteer is not;
 * - a response the client cannot read is reported as signed in;
 * - a declined Request is reported as answered rather than "Not allowed";
 * - the expiry keeps counting after it has passed, or rounds a live Request
 *   down to "less than a minute" too early;
 * - Settings draws a control for a vault this Mac can never open, or treats a
 *   broker that says "unsupported" as ready;
 * - a server or cloud Opensteer promises a Mac it does not have.
 */

const site = "https://example.com";
const runnerId = RunnerIdSchema.parse("rnr_11111111-1111-4111-8111-111111111111");

describe("passwordSignInOutcome", () => {
  const cases: readonly [PasswordSignInRequestResponse, string, boolean][] = [
    [{ method: "saved-password", outcome: "signed-in" }, "Signed in to example.com", true],
    [{ method: "person", outcome: "signed-in" }, "You signed in to example.com", true],
    [{ outcome: "expired" }, "This sign-in timed out", false],
    [
      { outcome: "failed", reason: "wrong-password" },
      "example.com didn’t accept the saved password",
      false,
    ],
    [
      { outcome: "failed", reason: "unsupported-page" },
      "Opensteer couldn’t find where to sign in on example.com",
      false,
    ],
    [
      { outcome: "failed", reason: "blocked-destination" },
      "The page tried to reach a blocked address, so nothing was handed to the agent",
      false,
    ],
    [
      { outcome: "failed", reason: "cleanup-failed" },
      "The private sign-in couldn’t be cleared, so nothing was handed to the agent",
      false,
    ],
    [{ outcome: "failed", reason: "busy" }, "Too many sign-ins at once", false],
    [
      { outcome: "failed", reason: "needs-fresh-session" },
      "This needs a new browser session. Ask your agent to open one and try again",
      false,
    ],
    [
      { outcome: "unavailable", reason: "passwords-off" },
      "Agent sign-ins are off on Mac mini",
      false,
    ],
    [{ outcome: "unavailable", reason: "not-set-up" }, "Passwords isn’t set up on Mac mini", false],
    [
      { outcome: "unavailable", reason: "not-responding" },
      "Passwords didn’t respond on Mac mini",
      false,
    ],
    [{ outcome: "outcome-unknown" }, "Opensteer couldn’t confirm the sign-in", false],
    [{ outcome: "session-closed" }, "The agent’s browser closed", false],
    [{ outcome: "interrupted" }, "The sign-in stopped on Mac mini", false],
  ];

  it.each(cases)("says what %o came to", (response, text, signedIn) => {
    const request = passwordRequest("fulfilled", response);
    expect(passwordSignInOutcome(request)).toEqual({ signedIn, text });
    expect(passwordSignInReceipt(request)).toBe(text);
  });

  it("says Not allowed for a decline, and nothing while it waits", () => {
    expect(passwordSignInOutcome(passwordRequest("declined", null))).toEqual({
      signedIn: false,
      text: "Not allowed",
    });
    expect(passwordSignInOutcome(passwordRequest("pending", null))).toBeNull();
  });

  it("never reports an unreadable response as signed in", () => {
    const request = {
      ...passwordRequest("fulfilled", null),
      response: { kind: "external", value: { outcome: "signed-in", method: "magic" } },
    } as Request;
    expect(passwordSignInOutcome(request)).toEqual({ signedIn: false, text: "Answered" });
  });

  it("folds a settled sign-in into the transcript in the card's words", () => {
    const request = passwordRequest("fulfilled", {
      method: "saved-password",
      outcome: "signed-in",
    });
    const event = {
      createdAt: "2026-10-11T12:00:00.000Z",
      data: { request },
      environmentId: createId("environment"),
      eventId: createId("event"),
      runId: request.originatingRunId,
      sequence: "1",
      threadId: request.originatingThreadId,
      type: "request.resolved",
      workspaceId: request.originatingWorkspaceId,
    } as AgentEvent;
    expect(foldTranscriptEvent([], event)).toEqual([
      expect.objectContaining({
        outcome: "Signed in to example.com",
        requestKind: "browser.password-sign-in",
      }),
    ]);
    const declined = { ...event, data: { request: passwordRequest("declined", null) } };
    expect(foldTranscriptEvent([], declined as AgentEvent)).toEqual([
      expect.objectContaining({ outcome: "Not allowed" }),
    ]);
  });
});

describe("where the sign-in is approved", () => {
  it("names the Mac everywhere but on that Mac, and the site everywhere", () => {
    expect(passwordSignInWaitingOn("Mac mini")).toBe("Waiting for you on Mac mini");
    expect(passwordSignInPrivacy("https://github.com")).toBe(
      "Opensteer fills your password into github.com for them — it never sends it to the agent, but the website page holds it once filled. Sign-ins can stay saved in the browser profile.",
    );
    expect(passwordSignInNoAccount("https://github.com")).toBe("No saved password for github.com.");
    expect(passwordSignInAllowRemembers("Main", "alex@company.example")).toBe(
      "Allow lets agents in Main sign in as alex@company.example from now on.",
    );
  });

  it("is here only in the desktop app on the approving Mac", () => {
    const base = {
      hostsDeploymentOnThisComputer: true,
      inDesktopApp: true,
      localRunnerId: null,
      runnerHostsDeployment: true,
      runnerId,
    };
    expect(passwordsHere(base)).toBe(true);
    // A browser tab on that very Mac has no bridge to reach Passwords.
    expect(passwordsHere({ ...base, inDesktopApp: false })).toBe(false);
    // The desktop app on another computer, opening this Opensteer remotely.
    expect(passwordsHere({ ...base, hostsDeploymentOnThisComputer: false })).toBe(false);
    // A Request naming some other Runner.
    expect(passwordsHere({ ...base, runnerHostsDeployment: false })).toBe(false);
    // A desktop that lends exactly that Runner is that Mac.
    expect(
      passwordsHere({
        ...base,
        hostsDeploymentOnThisComputer: false,
        localRunnerId: runnerId,
        runnerHostsDeployment: false,
      }),
    ).toBe(true);
  });
});

describe("passwordSignInExpiry", () => {
  const expiresAt = "2026-10-11T12:15:00.000Z";
  it("counts whole minutes up, then says Expired", () => {
    expect(passwordSignInExpiry(expiresAt, new Date("2026-10-11T12:00:00.000Z"))).toBe(
      "Expires in 15 minutes",
    );
    expect(passwordSignInExpiry(expiresAt, new Date("2026-10-11T12:13:30.000Z"))).toBe(
      "Expires in 2 minutes",
    );
    expect(passwordSignInExpiry(expiresAt, new Date("2026-10-11T12:14:00.000Z"))).toBe(
      "Expires in 1 minute",
    );
    expect(passwordSignInExpiry(expiresAt, new Date("2026-10-11T12:14:30.000Z"))).toBe(
      "Expires in less than a minute",
    );
    expect(passwordSignInExpiry(expiresAt, new Date("2026-10-11T12:15:00.000Z"))).toBe("Expired");
    expect(passwordSignInExpiry(expiresAt, new Date("2026-10-11T13:00:00.000Z"))).toBe("Expired");
  });
});

describe("passwordsSettingsState", () => {
  const available = (
    vault: "needs-reset" | "not-set-up" | "ready" | "unsupported",
  ): DesktopPasswordsStatus => ({
    availability: "available",
    broker: { agentSignIns: "on", vault },
    development: false,
  });

  it("names why a Mac can never keep Passwords", () => {
    expect(passwordsSettingsState({ availability: "unsupported", reason: "platform" })).toEqual({
      kind: "unsupported",
      message: "Passwords is available in the Opensteer app on a Mac.",
    });
    const hardware = {
      kind: "unsupported",
      message:
        "This Mac can’t keep Opensteer Passwords. It needs Touch ID–class security hardware (Apple silicon, or an Intel Mac with a T2 chip).",
    };
    expect(passwordsSettingsState({ availability: "unsupported", reason: "hardware" })).toEqual(
      hardware,
    );
    // The broker itself can say this Mac has no Secure Enclave.
    expect(passwordsSettingsState(available("unsupported"))).toEqual(hardware);
    expect(passwordsSettingsState({ availability: "unsupported", reason: "os" })).toEqual({
      kind: "unsupported",
      message: "Opensteer Passwords doesn’t work on this version of macOS yet.",
    });
  });

  it("passes the broker's own state through, with the development flag", () => {
    expect(
      passwordsSettingsState({ availability: "unavailable", message: "Passwords isn’t running." }),
    ).toEqual({ kind: "unavailable", message: "Passwords isn’t running." });
    expect(passwordsSettingsState(available("not-set-up"))).toEqual({
      development: false,
      kind: "not-set-up",
    });
    expect(passwordsSettingsState(available("needs-reset"))).toEqual({
      development: false,
      kind: "needs-reset",
    });
    expect(
      passwordsSettingsState({
        availability: "available",
        broker: { agentSignIns: "off", vault: "ready" },
        development: true,
      }),
    ).toEqual({ agentSignIns: "off", development: true, kind: "ready" });
  });

  it("counts the sign-ins waiting in the chat", () => {
    expect(passwordsWaitingDetail(1)).toBe("1 sign-in to answer in its conversation");
    expect(passwordsWaitingDetail(2)).toBe("2 sign-ins to answer in their conversations");
  });
});

describe("Passwords from anywhere but its Mac", () => {
  it("names the home Mac on a Personal Opensteer, and says it is Personal-only elsewhere", () => {
    expect(passwordsElsewhere({ homeName: "Mac mini", personal: true })).toBe(
      "Passwords are kept in the Opensteer app on Mac mini. Set them up and manage them there.",
    );
    expect(passwordsElsewhere({ homeName: "build.example.com", personal: false })).toBe(
      "Saved-password sign-ins are available on a Personal Opensteer for now.",
    );
    expect(passwordsSettingsSubtitle({ homeName: "Mac mini", personal: true })).toBe(
      "Kept on Mac mini",
    );
    expect(passwordsSettingsSubtitle({ homeName: "build.example.com", personal: false })).toBe(
      "Not available on this Opensteer",
    );
  });
});

function passwordRequest(
  status: Request["status"],
  response: PasswordSignInRequestResponse | null,
): Request {
  return {
    callId: "call-1",
    cancellationReason: null,
    createdAt: "2026-10-11T12:00:00.000Z",
    id: createId("request"),
    kind: "browser.password-sign-in",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: createId("workspace"),
    payload: {
      computerName: "Mac mini",
      expiresAt: "2026-10-11T12:15:00.000Z",
      kind: "browser.password-sign-in",
      operationId: crypto.randomUUID(),
      reason: "Download the October invoice",
      runnerId,
      sessionId: "bss_1",
      site,
    },
    presentation: {
      kind: "external",
      subject: { id: site, kind: "browser-site" },
      title: "Sign in to example.com",
    },
    requestedBy: createId("user"),
    requiredActor: "workspace-owner",
    resolvedAt: status === "pending" ? null : "2026-10-11T12:05:00.000Z",
    resolvedBy: status === "pending" ? null : createId("user"),
    response:
      status === "pending"
        ? null
        : { kind: "external", value: response === null ? { decision: "declined" } : response },
    status,
    targetWorkspaceId: createId("workspace"),
  } as Request;
}

describe("direct Passwords endings in the transcript", () => {
  it.each([
    ["passwords-off", "Agent sign-ins are off"],
    ["passwords-not-set-up", "Passwords isn’t set up on your Passwords Mac"],
    ["passwords-not-responding", "Passwords didn’t respond"],
    ["expired", "This sign-in timed out"],
    ["interrupted", "The sign-in stopped"],
    ["stopped", "The sign-in stopped"],
    ["busy", "Another agent is waiting for you to sign in to this site. Try again later"],
  ] as const)("renders %s without claiming a sign-in", (reason, hint) => {
    const result = { status: "unavailable", reason, site } as const;
    expect(browserSignInStep(result, site)).toMatchObject({ signedIn: false, hint });
  });
});

/*
 * How the card's account list could make the person pick the wrong account,
 * or fail to find the right one:
 * - accounts for other services on the same domain (AWS on amazon.com) sit
 *   among the ones for the page the agent is on, or come first;
 * - every row repeats a host, or rows on different hosts have no host at all;
 * - the disclosure for the other hosts counts wrong, or the site's accounts
 *   are hidden behind it when none is for the page;
 * - two rows read the same: the same username on the same host with no
 *   label, even when both were updated the same month;
 * - a row says something that tells it apart from nothing (a date on a
 *   username that appears once);
 * - the broker's order (page first, host, username, newest) is reshuffled;
 * - the filter misses a username, label or host by case, keeps empty host
 *   headings, or changes what tells two rows apart as it narrows.
 */
describe("the accounts a sign-in card offers", () => {
  it("puts the page's accounts first, then the site's other hosts each under its host", () => {
    const list = passwordSignInAccountList(amazon);
    expect(list.primary).toEqual([
      {
        host: null,
        rows: [
          { account: amazon[0], detail: null },
          { account: amazon[1], detail: null },
          { account: amazon[2], detail: null },
          { account: amazon[3], detail: null },
        ],
      },
    ]);
    expect(list.others.map(({ host, rows }) => [host, rows.map(({ detail }) => detail)])).toEqual([
      ["portal.aws.amazon.com", [null]],
      [
        "signin.aws.amazon.com",
        [null, "Updated Mar 2026", "Updated Nov 2025", "Updated Jun 2025", "Updated Sep 2024"],
      ],
      ["us-east-1.signin.aws.amazon.com", [null]],
    ]);
    expect(list.others.flatMap(({ rows }) => rows.map(({ account }) => account))).toEqual(
      amazon.slice(4),
    );
    expect(passwordSignInOtherAccounts("https://amazon.com", 7)).toBe(
      "Other accounts on amazon.com (7)",
    );
  });

  it("lists the site's accounts by host, unhidden, when none is for the page", () => {
    // The broker's order with no account on the page: by host, then username.
    const offPage = [...amazon.slice(4), ...amazon.slice(0, 4)].map((entry) => ({
      ...entry,
      onPage: false,
    }));
    const list = passwordSignInAccountList(offPage);
    expect(list.others).toEqual([]);
    expect(list.primary.map(({ host, rows }) => [host, rows.length])).toEqual([
      ["portal.aws.amazon.com", 1],
      ["signin.aws.amazon.com", 5],
      ["us-east-1.signin.aws.amazon.com", 1],
      ["www.amazon.com", 4],
    ]);
    // One host needs no heading: the card's title already names the site.
    const github = [account({ host: "github.com", onPage: false, username: "alex" })];
    expect(passwordSignInAccountList(github).primary).toEqual([
      { host: null, rows: [{ account: github[0], detail: null }] },
    ]);
  });

  it("tells rows apart only where they need it: a label, else when each was updated", () => {
    const work = account({ label: "Work", username: "alex@example.com" });
    const home = account({ label: "Home", username: "Alex@example.com" });
    const plain = account({ label: "Personal", username: "jo@example.com" });
    const sameMonth = [
      account({ updatedAt: "2026-05-02T12:00:00.000Z", username: "ops@example.com" }),
      account({ updatedAt: "2026-03-14T12:00:00.000Z", username: "ops@example.com" }),
      account({ updatedAt: "2026-03-03T12:00:00.000Z", username: "ops@example.com" }),
      account({
        host: "admin.example.com",
        updatedAt: "2026-03-03T12:00:00.000Z",
        username: "ops@example.com",
      }),
    ];
    const rows = passwordSignInAccountList([work, home, plain, ...sameMonth]).primary.flatMap(
      ({ rows }) => rows.map(({ detail }) => detail),
    );
    expect(rows).toEqual([
      "Work",
      "Home",
      "Personal",
      "Updated May 2, 2026",
      "Updated Mar 14, 2026",
      "Updated Mar 3, 2026",
      null,
    ]);
  });

  it("narrows by username, label or host, whatever the case, and keeps each row's detail", () => {
    const list = passwordSignInAccountList(amazon, "  ALEX@EXAMPLE.COM ");
    expect(list.primary).toEqual([]);
    expect(list.others.map(({ host, rows }) => [host, rows.map(({ detail }) => detail)])).toEqual([
      ["portal.aws.amazon.com", [null]],
      [
        "signin.aws.amazon.com",
        ["Updated Mar 2026", "Updated Nov 2025", "Updated Jun 2025", "Updated Sep 2024"],
      ],
      ["us-east-1.signin.aws.amazon.com", [null]],
    ]);
    expect(passwordSignInAccountList(amazon, "portal").others.map(({ host }) => host)).toEqual([
      "portal.aws.amazon.com",
    ]);
    const labelled = [account({ label: "Family Prime", username: "jo@example.com" })];
    expect(passwordSignInAccountList(labelled, "prime").primary[0]?.rows).toHaveLength(1);
    expect(passwordSignInAccountList(amazon, "nobody")).toEqual({ others: [], primary: [] });
    expect(passwordSignInNoAccountMatch("nobody")).toBe("No account matches “nobody”");
  });
});

let accountCount = 0;

function account(
  input: Partial<PasswordSignInAccount> & { readonly username: string },
): PasswordSignInAccount {
  accountCount += 1;
  return {
    host: "www.example.com",
    id: `0192f4a1-9999-4000-8000-${String(accountCount).padStart(12, "0")}`,
    label: null,
    onPage: true,
    revision: 1,
    updatedAt: "2026-01-15T12:00:00.000Z",
    ...input,
  };
}

/**
 * The person's amazon.com logins as the broker sends them: twelve saved, one
 * an exact copy it folds away, the page's first, then by host, username and
 * newest.
 */
const amazon: readonly PasswordSignInAccount[] = [
  account({ host: "www.amazon.com", username: "jordan3696@example.com" }),
  account({ host: "www.amazon.com", username: "morgan@example.com" }),
  account({ host: "www.amazon.com", username: "alex@company.example" }),
  account({ host: "www.amazon.com", username: "alex901@example.com" }),
  ...[
    ["portal.aws.amazon.com", "alex@example.com", "2025-08-10"],
    ["signin.aws.amazon.com", "alex@company.example", "2025-12-01"],
    ["signin.aws.amazon.com", "alex@example.com", "2026-03-14"],
    ["signin.aws.amazon.com", "alex@example.com", "2025-11-02"],
    ["signin.aws.amazon.com", "alex@example.com", "2025-06-20"],
    ["signin.aws.amazon.com", "alex@example.com", "2024-09-08"],
    ["us-east-1.signin.aws.amazon.com", "alex@example.com", "2025-02-17"],
  ].map(([host, username, day]) =>
    account({ host: host!, onPage: false, updatedAt: `${day}T12:00:00.000Z`, username: username! }),
  ),
];

it("describes Workspace consent for v5 without changing v4 wording", () => {
  expect(passwordSignInConsent("Main", "https://instagram.com", "a•••@example.com", 5)).toBe(
    "Agents in Main want to use your saved login a•••@example.com for instagram.com. They can type it on this website and in apps they use, like on your phone. Agents never see it, but a tricked agent could reveal it.",
  );
  expect(passwordSignInConsent("Main", "https://instagram.com", "a•••@example.com")).toContain(
    "Sign-ins can stay saved in the browser profile.",
  );
});
