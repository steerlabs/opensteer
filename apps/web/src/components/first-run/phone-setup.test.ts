import { describe, expect, it } from "vitest";
import type { AuthSessionSummary } from "@opensteer/core";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import {
  newestNewPhoneSession,
  phoneOpenUrl,
  phoneReach,
  type PhoneReachFacts,
} from "./phone-setup.js";

const deploymentId = "dep_01J0000000000000000000000";

function remote(
  access: Partial<PersonalRemoteAdministrationStatus["access"]> = {},
  overrides: Partial<PersonalRemoteAdministrationStatus> = {},
): PersonalRemoteAdministrationStatus {
  return {
    access: {
      accountLink: { state: "active" },
      generation: 1,
      mode: "off",
      route: null,
      schemaVersion: 2,
      ...access,
    },
    accountIssuer: "https://accounts.opensteer.test",
    executorConnected: true,
    operation: null,
    revision: 1,
    ...overrides,
  } as unknown as PersonalRemoteAdministrationStatus;
}

function facts(overrides: Partial<PhoneReachFacts> = {}): PhoneReachFacts {
  return {
    accountAvailable: true,
    deploymentId,
    link: "linked",
    portalOrigin: "https://app.opensteer.test",
    remote: remote(),
    remoteUnreadable: false,
    ...overrides,
  };
}

const route = {} as PersonalRemoteAdministrationStatus["access"]["route"];

describe("phoneReach", () => {
  it("is not offered without an Account, a portal address, this computer's id or a readable status", () => {
    expect(phoneReach(facts({ accountAvailable: false })).kind).toBe("unavailable");
    expect(phoneReach(facts({ portalOrigin: null })).kind).toBe("unavailable");
    expect(phoneReach(facts({ deploymentId: null })).kind).toBe("unavailable");
    expect(phoneReach(facts({ remote: null, remoteUnreadable: true })).kind).toBe("unavailable");
    expect(phoneReach(facts({ link: "unavailable" })).kind).toBe("unavailable");
    expect(phoneReach(facts({ remote: remote({}, { accountIssuer: null }) })).kind).toBe(
      "unavailable",
    );
  });

  it("waits while the status is still being read", () => {
    expect(phoneReach(facts({ remote: null })).kind).toBe("checking");
    expect(phoneReach(facts({ link: null })).kind).toBe("checking");
    expect(phoneReach(facts({ link: "unlinking" })).kind).toBe("checking");
  });

  it("names the next missing step from live state, skipping what is already done", () => {
    expect(
      phoneReach(facts({ link: "unlinked", remote: remote({ accountLink: null }) })).kind,
    ).toBe("needs-link");
    // A link the Host committed but the Account has not activated still needs finishing.
    expect(phoneReach(facts({ link: "activating" })).kind).toBe("needs-link");
    expect(
      phoneReach(facts({ remote: remote({ accountLink: { state: "activating" } as never }) })).kind,
    ).toBe("needs-link");
    expect(phoneReach(facts()).kind).toBe("needs-connect");
    expect(phoneReach(facts({ remote: remote({ mode: "connect" }) })).kind).toBe("publishing");
    expect(phoneReach(facts({ remote: remote({ mode: "connect", route }) }))).toEqual({
      kind: "reachable",
      url: `https://app.opensteer.test/open#d=${deploymentId}`,
    });
  });

  it("leaves private-network access alone and explains links it cannot fix here", () => {
    expect(phoneReach(facts({ remote: remote({ mode: "private", route }) })).kind).toBe(
      "private-network",
    );
    expect(phoneReach(facts({ link: "linked-elsewhere" }))).toMatchObject({ kind: "blocked" });
    expect(phoneReach(facts({ link: "needs-repair" }))).toMatchObject({ kind: "blocked" });
  });
});

describe("phoneOpenUrl", () => {
  it("carries only the computer id, in the fragment, on the portal origin", () => {
    const url = new URL(phoneOpenUrl("https://app.opensteer.test/some/path?x=1", deploymentId));
    expect(url.origin).toBe("https://app.opensteer.test");
    expect(url.pathname).toBe("/open");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#d=${deploymentId}`);
  });
});

describe("newestNewPhoneSession", () => {
  const session = (overrides: Partial<Record<keyof AuthSessionSummary, unknown>>) =>
    ({
      absoluteExpiresAt: "2026-12-01T00:00:00.000Z",
      createdAt: "2026-11-03T10:00:00.000Z",
      current: false,
      deviceLabel: "Opensteer on iPhone",
      expiresAt: "2026-12-01T00:00:00.000Z",
      form: "mobile",
      id: "ses_a",
      lastSeenAt: "2026-11-03T10:00:00.000Z",
      ...overrides,
    }) as AuthSessionSummary;

  it("reports only a phone that signed in after the code appeared", () => {
    const old = session({ id: "ses_old" });
    const computer = session({ form: "computer", id: "ses_mac" });
    const here = session({ current: true, id: "ses_here" });
    const first = session({ createdAt: "2026-11-03T10:05:00.000Z", id: "ses_new1" });
    const second = session({
      createdAt: "2026-11-03T10:06:00.000Z",
      deviceLabel: "Opensteer on Pixel",
      id: "ses_new2",
    });
    const baseline = new Set(["ses_old"]);
    expect(newestNewPhoneSession([old, computer, here], baseline)).toBeNull();
    expect(newestNewPhoneSession([old, first, second], baseline)?.deviceLabel).toBe(
      "Opensteer on Pixel",
    );
  });
});
