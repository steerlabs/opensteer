import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  type BrowserProfileId,
  type EnvironmentId,
  type HarnessInstanceId,
  type RunnerId,
  type TabId,
  type UserId,
} from "@opensteer/core";
import { harnessChallengeReturnsToLoopback } from "@opensteer/protocol";
import type {
  HarnessAuthenticationCoordinator,
  HarnessAuthenticationTarget,
} from "./harness-authentication-coordinator.js";

/** The profile engine sign-ins open in, so a provider's cookies stay out of every other one. */
export const harnessSignInProfileName = "AI engine sign-in";

export interface HarnessSignInBrowserDependencies {
  /** Whether the browser on this computer can open a page now. */
  readonly browserAvailable: (runnerId: RunnerId) => boolean;
  readonly listProfiles: (ownerId: UserId) => Promise<
    readonly {
      readonly home: { readonly runnerId: RunnerId } | null;
      readonly id: BrowserProfileId;
      readonly name: string;
      readonly purpose?: "person" | "engine-sign-in";
    }[]
  >;
  readonly createProfile: (input: {
    readonly homeRunnerId: RunnerId;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly ownerId: UserId;
    /** Marks it so no connected agent's grant can name it. */
    readonly purpose: "engine-sign-in";
  }) => Promise<{ readonly id: BrowserProfileId }>;
  readonly openTab: (
    ownerId: UserId,
    target: { readonly kind: "page"; readonly profileId: BrowserProfileId; readonly url: string },
    idempotencyKey: string,
  ) => Promise<TabId>;
  /** Whether the person still has this tab; they may have closed it themselves. */
  readonly hasTab: (ownerId: UserId, tabId: TabId) => Promise<boolean>;
  readonly closeTab: (ownerId: UserId, tabId: TabId, idempotencyKey: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

interface OpenSignIn {
  readonly ownerId: UserId;
  readonly tabId: TabId;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly url: string;
}

/**
 * Finishes a browser sign-in that returns to the engine's own computer in that
 * computer's browser. A provider sends the browser back to a loopback address
 * there, which no other device can reach, so the page opens as a tab in the
 * Home's browser and the person completes it through the tab they already use.
 * The tab is the attempt's: it closes when the attempt ends.
 */
export class HarnessSignInBrowser {
  readonly #dependencies: HarnessSignInBrowserDependencies;
  readonly #open = new Map<string, OpenSignIn>();
  readonly #profiles = new Map<string, Promise<BrowserProfileId>>();

  constructor(dependencies: HarnessSignInBrowserDependencies) {
    this.#dependencies = dependencies;
  }

  /** Follows the coordinator, so every way an attempt ends closes its tab. */
  follow(coordinator: Pick<HarnessAuthenticationCoordinator, "onAttemptEnded">): () => void {
    return coordinator.onAttemptEnded(
      (environmentId, harnessInstanceId) => void this.settle(environmentId, harnessInstanceId),
    );
  }

  async browse(input: {
    readonly coordinator: Pick<HarnessAuthenticationCoordinator, "trackAttempt" | "read">;
    readonly ownerId: UserId;
    readonly runnerId: RunnerId | undefined;
    readonly signal: AbortSignal;
    readonly target: HarnessAuthenticationTarget;
  }): Promise<TabId> {
    const environmentId = input.target.environment.id;
    const harnessInstanceId = input.target.harness.id;
    const remaining = input.coordinator.trackAttempt(environmentId, harnessInstanceId);
    const envelope = await input.coordinator.read(input.target, input.signal);
    if (envelope.environmentStatus !== "connected" || input.runnerId === undefined)
      throw new OpensteerError({
        code: "conflict",
        message: "Reconnect this work location to finish signing in",
        retryable: true,
      });
    const authentication = envelope.authentication;
    if (authentication.status !== "pending" || remaining() === 0) throw signInEnded();
    if (
      authentication.challenge.kind !== "browser-code" ||
      !harnessChallengeReturnsToLoopback(authentication.challenge)
    )
      throw new OpensteerError({
        code: "conflict",
        message: "This sign-in finishes on your own device, not in a browser on that computer.",
      });
    return this.#openTab(
      this.#key(environmentId, harnessInstanceId),
      input.ownerId,
      input.runnerId,
      authentication.challenge.authorizationUrl,
      remaining,
    );
  }

  /** Closes what this attempt opened. Safe to call for an attempt that opened nothing. */
  async settle(environmentId: EnvironmentId, harnessInstanceId: HarnessInstanceId): Promise<void> {
    const key = this.#key(environmentId, harnessInstanceId);
    const open = this.#open.get(key);
    if (!open) return;
    this.#open.delete(key);
    clearTimeout(open.timer);
    await this.#close(open.ownerId, open.tabId);
  }

  async #openTab(
    key: string,
    ownerId: UserId,
    runnerId: RunnerId,
    url: string,
    remaining: () => number,
  ): Promise<TabId> {
    const existing = this.#open.get(key);
    if (
      existing?.ownerId === ownerId &&
      existing.url === url &&
      (await this.#dependencies.hasTab(ownerId, existing.tabId))
    ) {
      if (remaining() === 0) throw signInEnded();
      return existing.tabId;
    }
    if (remaining() === 0) throw signInEnded();
    if (existing && this.#open.get(key) === existing) {
      this.#open.delete(key);
      clearTimeout(existing.timer);
      await this.#close(existing.ownerId, existing.tabId);
    }
    if (!this.#dependencies.browserAvailable(runnerId))
      throw new OpensteerError({
        code: "conflict",
        reason: "harness-sign-in-browser-unavailable",
        message:
          "The computer this AI engine runs on has no browser to finish this sign-in in. Open the sign-in page on this device instead.",
      });
    const profileId = await this.#profile(ownerId, runnerId);
    if (remaining() === 0) throw signInEnded();
    const tabId = await this.#dependencies.openTab(
      ownerId,
      { kind: "page", profileId, url },
      `harness-sign-in:${randomUUID()}`,
    );
    // The attempt ended, or another open replaced this one, while the page opened.
    const timeout = remaining();
    if (timeout === 0 || this.#open.has(key)) {
      await this.#close(ownerId, tabId);
      throw signInEnded();
    }
    const timer = setTimeout(() => {
      const open = this.#open.get(key);
      if (open?.tabId !== tabId) return;
      this.#open.delete(key);
      void this.#close(ownerId, tabId);
    }, timeout);
    timer.unref?.();
    this.#open.set(key, { ownerId, tabId, timer, url });
    return tabId;
  }

  /** One sign-in profile per person and computer, made the first time it is needed. */
  #profile(ownerId: UserId, runnerId: RunnerId): Promise<BrowserProfileId> {
    const key = `${ownerId}:${runnerId}`;
    const pending = this.#profiles.get(key);
    if (pending) return pending;
    const created = (async () => {
      const profiles = await this.#dependencies.listProfiles(ownerId);
      const existing = profiles.find(
        (profile) => profile.purpose === "engine-sign-in" && profile.home?.runnerId === runnerId,
      );
      if (existing) return existing.id;
      const profile = await this.#dependencies.createProfile({
        homeRunnerId: runnerId,
        idempotencyKey: `harness-sign-in-profile:${randomUUID()}`,
        name: harnessSignInProfileName,
        ownerId,
        purpose: "engine-sign-in",
      });
      return profile.id;
    })();
    // Only concurrent opens share one lookup; a later one reads the profiles again,
    // since the person may have renamed or deleted it.
    this.#profiles.set(key, created);
    void created.then(
      () => this.#profiles.delete(key),
      () => this.#profiles.delete(key),
    );
    return created;
  }

  async #close(ownerId: UserId, tabId: TabId): Promise<void> {
    try {
      await this.#dependencies.closeTab(ownerId, tabId, `harness-sign-in-close:${tabId}`);
    } catch (error) {
      this.#dependencies.onError(error);
    }
  }

  #key(environmentId: EnvironmentId, harnessInstanceId: HarnessInstanceId): string {
    return `${environmentId}:${harnessInstanceId}`;
  }
}

function signInEnded(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "This sign-in has ended. Start it again.",
  });
}
