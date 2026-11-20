import {
  createId,
  HarnessIdSchema,
  type BrowserProfileId,
  type RunnerId,
  type TabId,
  type UserId,
} from "@opensteer/core";
import type { HarnessAuthenticationState } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessAuthenticationCoordinator,
  type HarnessAuthenticationTarget,
} from "./harness-authentication-coordinator.js";
import { HarnessSignInBrowser, harnessSignInProfileName } from "./harness-sign-in-browser.js";

const ownerId = createId("user") as UserId;
const homeRunner = createId("runner") as RunnerId;
const otherRunner = createId("runner") as RunnerId;
const environmentId = createId("environment");
const target: HarnessAuthenticationTarget = {
  environment: { id: environmentId, kind: "main" },
  harness: {
    config: {},
    driverKind: HarnessIdSchema.parse("antigravity"),
    id: createId("harnessInstance"),
    name: "Antigravity",
    runtimeRevision: 1,
    sourceId: "google",
    stateKind: "isolated",
  },
};
const signal = new AbortController().signal;
const selection = { methodId: "antigravity-oauth" } as const;

function browserCode(redirect: string, state = "first"): HarnessAuthenticationState {
  const authorizationUrl = new URL("https://accounts.example.test/o/oauth2/auth");
  authorizationUrl.searchParams.set("redirect_uri", redirect);
  authorizationUrl.searchParams.set("state", state);
  return {
    challenge: {
      authorizationUrl: authorizationUrl.href,
      inputPrompt: "Paste the complete address from the browser after it redirects",
      kind: "browser-code",
    },
    status: "pending",
  };
}
const loopback = browserCode("http://127.0.0.1:51121/oauth-callback");

function fixture(
  options: {
    readonly browser?: boolean;
    readonly profiles?: {
      id: BrowserProfileId;
      name: string;
      runnerId: RunnerId | null;
      purpose: "person" | "engine-sign-in";
    }[];
  } = {},
) {
  let state: HarnessAuthenticationState = loopback;
  let now = 1_000;
  const coordinator = new HarnessAuthenticationCoordinator({
    harnesses: { getHarnessInstance: async () => ({ ...target.harness, enabled: true }) },
    maximumLifetimeMs: 15 * 60_000,
    now: () => now,
    runners: {
      isAvailable: () => true,
      manageHarnessAuthentication: async (_environmentId, request) =>
        request.action === "cancel" ? { status: "not-started" } : state,
    },
  });
  const profiles = [...(options.profiles ?? [])];
  const tabs = new Map<TabId, { profileId: BrowserProfileId; url: string }>();
  const closed: TabId[] = [];
  const createProfile = vi.fn(
    async (input: { homeRunnerId: RunnerId; name: string; ownerId: UserId }) => {
      const id = createId("browserProfile") as BrowserProfileId;
      profiles.push({
        id,
        name: input.name,
        runnerId: input.homeRunnerId,
        purpose: "engine-sign-in",
      });
      return { id };
    },
  );
  const browser = new HarnessSignInBrowser({
    browserAvailable: (runnerId) => (options.browser ?? true) && runnerId === homeRunner,
    closeTab: async (_ownerId, tabId) => {
      tabs.delete(tabId);
      closed.push(tabId);
    },
    createProfile,
    hasTab: async (_ownerId, tabId) => tabs.has(tabId),
    listProfiles: async () =>
      profiles.map(({ id, name, runnerId, purpose }) => ({
        home: runnerId ? { runnerId } : null,
        id,
        name,
        purpose,
      })),
    onError: (error) => {
      throw error;
    },
    openTab: async (_ownerId, page) => {
      const tabId = createId("tab") as TabId;
      tabs.set(tabId, { profileId: page.profileId, url: page.url });
      return tabId;
    },
  });
  browser.follow(coordinator);
  const browse = () =>
    browser.browse({ coordinator, ownerId, runnerId: homeRunner, signal, target });
  return {
    browse,
    closed,
    coordinator,
    createProfile,
    profiles,
    setNow: (value: number) => {
      now = value;
    },
    setState: (value: HarnessAuthenticationState) => {
      state = value;
    },
    tabs,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HarnessSignInBrowser", () => {
  it("opens a sign-in that returns to the engine's computer in that computer's sign-in profile", async () => {
    const theirs = createId("browserProfile") as BrowserProfileId;
    const elsewhere = createId("browserProfile") as BrowserProfileId;
    const signIn = fixture({
      profiles: [
        { id: theirs, name: harnessSignInProfileName, runnerId: homeRunner, purpose: "person" },
        {
          id: elsewhere,
          name: harnessSignInProfileName,
          runnerId: otherRunner,
          purpose: "engine-sign-in",
        },
      ],
    });
    await signIn.coordinator.ensure(target, signal, selection);

    const tabId = await signIn.browse();
    const page = signIn.tabs.get(tabId)!;
    expect(page.url).toBe(
      loopback.status === "pending" && loopback.challenge.kind === "browser-code"
        ? loopback.challenge.authorizationUrl
        : null,
    );
    // Never a profile the person browses in, nor another computer's sign-in profile.
    expect(page.profileId).not.toBe(theirs);
    expect(page.profileId).not.toBe(elsewhere);
    expect(signIn.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        homeRunnerId: homeRunner,
        name: harnessSignInProfileName,
        ownerId,
      }),
    );
    // Asking again shows the same page, and the profile is made once.
    await expect(signIn.browse()).resolves.toBe(tabId);
    expect(signIn.createProfile).toHaveBeenCalledTimes(1);

    // A later sign-in reuses that computer's sign-in profile.
    signIn.setState({ status: "ready" });
    await signIn.coordinator.read(target, signal);
    signIn.setState(loopback);
    await signIn.coordinator.ensure(target, signal, selection);
    const again = await signIn.browse();
    expect(signIn.tabs.get(again)?.profileId).toBe(page.profileId);
    expect(signIn.createProfile).toHaveBeenCalledTimes(1);
  });

  it("closes the page when the sign-in finishes, fails, or is cancelled", async () => {
    for (const end of ["ready", "failed", "cancel"] as const) {
      const signIn = fixture();
      await signIn.coordinator.ensure(target, signal, selection);
      const tabId = await signIn.browse();
      if (end === "cancel") await signIn.coordinator.cancel(target, signal);
      else {
        signIn.setState(
          end === "ready" ? { status: "ready" } : { detail: "Denied", status: "failed" },
        );
        await signIn.coordinator.read(target, signal);
      }
      await vi.waitFor(() => expect(signIn.closed).toEqual([tabId]));
      expect(signIn.tabs.size).toBe(0);
    }
  });

  it("closes the page when the attempt outlives its deadline, even if nobody asks again", async () => {
    vi.useFakeTimers();
    const signIn = fixture();
    await signIn.coordinator.ensure(target, signal, selection);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    signIn.setNow(1_000 + 5 * 60_000);
    const tabId = await signIn.browse();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(signIn.tabs.has(tabId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(signIn.closed).toEqual([tabId]);

    // The coordinator's own deadline closes it too, when something asks first.
    vi.useRealTimers();
    const later = fixture();
    await later.coordinator.ensure(target, signal, selection);
    const second = await later.browse();
    later.setNow(1_000 + 15 * 60_000);
    expect(later.coordinator.isLive(environmentId, target.harness.id)).toBe(false);
    await vi.waitFor(() => expect(later.closed).toEqual([second]));
  });

  it("opens a new page for a new challenge and closes the old one", async () => {
    const signIn = fixture();
    await signIn.coordinator.ensure(target, signal, selection);
    const first = await signIn.browse();
    signIn.setState(browserCode("http://127.0.0.1:51122/oauth-callback", "second"));
    const second = await signIn.browse();
    expect(second).not.toBe(first);
    expect(signIn.closed).toEqual([first]);
    // The person closed the page themselves: asking again opens it again.
    signIn.tabs.delete(second);
    const third = await signIn.browse();
    expect(third).not.toBe(second);
  });

  it("refuses when the engine's computer has no browser, and opens nothing", async () => {
    const signIn = fixture({ browser: false });
    await signIn.coordinator.ensure(target, signal, selection);
    await expect(signIn.browse()).rejects.toMatchObject({
      code: "conflict",
      reason: "harness-sign-in-browser-unavailable",
    });
    expect(signIn.createProfile).not.toHaveBeenCalled();
    expect(signIn.tabs.size).toBe(0);
  });

  it("refuses a sign-in the person finishes on their own device", async () => {
    const signIn = fixture();
    await signIn.coordinator.ensure(target, signal, selection);
    for (const state of [
      // Claude's paste-a-code page returns to the provider, not to the computer.
      browserCode("https://platform.example.test/oauth/code/callback"),
      {
        challenge: {
          kind: "device-code",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://example.test/device",
        },
        status: "pending",
      },
      { challenge: { inputLabel: "API key", kind: "secret-input" }, status: "pending" },
    ] satisfies HarnessAuthenticationState[]) {
      signIn.setState(state);
      await expect(signIn.browse()).rejects.toMatchObject({
        message: "This sign-in finishes on your own device, not in a browser on that computer.",
      });
    }
    expect(signIn.tabs.size).toBe(0);
  });

  it("refuses once the sign-in has ended", async () => {
    const signIn = fixture();
    await expect(signIn.browse()).rejects.toMatchObject({
      message: "This sign-in has ended. Start it again.",
    });
    expect(signIn.tabs.size).toBe(0);
  });
});
