import {
  OpensteerError,
  type DeploymentId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { RequestStore } from "@opensteer/database";
import type {
  PasswordSignInAvailability,
  SavedLoginResult,
  SavedLoginUnavailableReason,
  UseCardResult,
} from "@opensteer/protocol";
import type { PersonalHostAccessRouteEnvelope } from "@opensteer/deployment-authority";
import type { BrowserService } from "./browser-service.js";
import type { PasswordSignInService } from "./password-sign-in-service.js";
import {
  PasswordsOffers,
  type PasswordsOffer,
  type PasswordsOfferOutcome,
} from "./passwords-offers.js";
import {
  admitSignIn,
  parseSignInSessionId,
  parseSignInSite,
  signInSiteRefusal,
} from "./sign-in-admission.js";

interface AgentCall {
  readonly ownerId: UserId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly deploymentId: DeploymentId;
  readonly callId: string;
  readonly reason: string;
  readonly site: string;
}

export type SavedLoginInput = AgentCall & {
  /** Omitted for a genuine Mac or phone app. */
  readonly sessionId?: string;
  /** Whether the calling Runner can fill a released login into a browser field. */
  readonly loginFill: boolean;
};

export type CardUseInput = AgentCall & { readonly sessionId: string };

type Passwords = Pick<
  PasswordSignInService,
  "join" | "probe" | "probeCard" | "replayResult" | "request" | "requestCard"
>;

/**
 * Agents' way into Opensteer Passwords: saved logins and cards, each released
 * through the person's approval into one target. It also watches sign-ins that
 * found Passwords lacking, and tells the agent once the person fixes that.
 */
export class SavedLoginService {
  readonly #passwords: Passwords;
  readonly #browser: Pick<BrowserService, "signInTarget">;
  readonly #requests: Pick<RequestStore, "findByCallIdentity" | "hasPendingDurableRequest">;
  readonly #refusesSite: (site: string) => Promise<boolean>;
  readonly #onLoginSaved: (offer: PasswordsOffer) => Promise<void>;
  readonly #stoppedByPerson: (threadId: ThreadId) => Promise<boolean>;
  readonly #now: () => number;
  readonly #offers: PasswordsOffers;
  readonly #calls = new Map<string, number[]>();
  readonly #turns = new Map<string, Promise<unknown>>();
  readonly #signIns = new Map<string, Promise<void>>();

  constructor(options: {
    readonly passwords: Passwords;
    readonly browser: Pick<BrowserService, "signInTarget">;
    readonly requests: Pick<RequestStore, "findByCallIdentity" | "hasPendingDurableRequest">;
    readonly canonicalOrigin: string;
    readonly currentRoute: () => Promise<PersonalHostAccessRouteEnvelope | null>;
    /** Tells a Thread the login its agent was missing now exists. */
    readonly onLoginSaved: (offer: PasswordsOffer) => Promise<void>;
    /** Whether the person stopped the Thread's newest Run themselves. */
    readonly stoppedByPerson: (threadId: ThreadId) => Promise<boolean>;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
  }) {
    this.#passwords = options.passwords;
    this.#browser = options.browser;
    this.#requests = options.requests;
    this.#refusesSite = signInSiteRefusal(options);
    this.#onLoginSaved = options.onLoginSaved;
    this.#stoppedByPerson = options.stoppedByPerson;
    this.#now = options.now ?? Date.now;
    this.#offers = new PasswordsOffers({
      now: this.#now,
      onError: options.onError ?? (() => {}),
      probe: (ownerId, site) => this.#passwords.probe(ownerId, site),
      wake: (offer) => this.#wake(offer),
    });
  }

  async useSavedLogin(input: SavedLoginInput): Promise<SavedLoginResult> {
    const site = parseSignInSite(input.site);
    const key = offerKey(input.threadId, site);
    const result = (this.#turns.get(key) ?? Promise.resolve()).then(async () => {
      const result = await this.#signIn({ ...input, site });
      this.#offers.note(
        {
          ownerId: input.ownerId,
          runId: input.runId,
          sessionId: input.sessionId ?? null,
          site,
          threadId: input.threadId,
        },
        result,
      );
      return result;
    });
    const settled = Promise.allSettled([this.#signIns.get(key), result]).then(() => undefined);
    this.#signIns.set(key, settled);
    void settled.then(() => {
      if (this.#signIns.get(key) === settled) this.#signIns.delete(key);
    });
    return result;
  }

  async useCard(input: CardUseInput): Promise<UseCardResult> {
    const site = parseSignInSite(input.site);
    const unavailable = (reason: Extract<UseCardResult, { status: "unavailable" }>["reason"]) => ({
      status: "unavailable" as const,
      site,
      reason,
    });
    if (await this.#refusesSite(site)) return unavailable("not-allowed");
    const sessionId = parseSignInSessionId(input.sessionId);
    const check = () =>
      this.#browser.signInTarget({
        agentBindingId: `run:${input.runId}`,
        ownerId: input.ownerId,
        sessionId,
      });
    const target = await check();
    if (!target?.live) return unavailable("session-closed");
    if (!target.main) return unavailable("main-browser-required");
    const availability = await this.#passwords.probeCard(input.ownerId);
    const current = await check();
    if (!current?.live || current.computer?.runnerId !== target.computer?.runnerId)
      return unavailable("session-closed");
    switch (availability) {
      case "has-card":
        break;
      case "unsupported":
      case "runtime-outdated":
        return unavailable(availability);
      case "no-card":
        return unavailable("no-saved-card");
      case "off":
        return unavailable("passwords-off");
      case "not-set-up":
        return unavailable("passwords-not-set-up");
      default:
        return unavailable("passwords-not-responding");
    }
    if (!current.cardFill || !target.computer) return unavailable("runtime-outdated");
    const result = await this.#passwords.requestCard({
      ...input,
      site,
      cardRunnerId: target.computer.runnerId,
      admitStart: () => this.#admit(input.runId, input.deploymentId, site),
    });
    const after = await check();
    if (!after?.live || !after.cardFill || after.computer?.runnerId !== target.computer.runnerId)
      return unavailable("session-closed");
    return result;
  }

  /** One pass over the sign-ins waiting on Passwords; a timer runs it while any wait. */
  sweepOffers(): Promise<void> {
    return this.#offers.sweep();
  }

  close(): void {
    this.#offers.close();
  }

  async #signIn(input: SavedLoginInput & { readonly site: string }): Promise<SavedLoginResult> {
    const { site } = input;
    const call = { ...input, arrivedAt: Date.now() };
    if (await this.#refusesSite(site)) return unavailable(site, "not-allowed");
    const sessionId = input.sessionId === undefined ? null : parseSignInSessionId(input.sessionId);
    const target =
      sessionId === null
        ? null
        : await this.#browser.signInTarget({
            agentBindingId: `run:${input.runId}`,
            ownerId: input.ownerId,
            sessionId,
          });
    const fillsHere =
      sessionId === null || (input.loginFill && !!target?.live && target.main && target.signIn);
    const joined = fillsHere ? this.#passwords.join(call) : null;
    if (joined) return joined;
    const prior = await this.#requests.findByCallIdentity({
      callId: input.callId,
      originatingRunId: input.runId,
    });
    if (prior) {
      if (
        prior.payload.kind !== "browser.password-sign-in" ||
        prior.payload.scope !== "personal" ||
        prior.payload.site !== site
      )
        throw new OpensteerError({
          code: "conflict",
          message: "This call already asked for a different site.",
        });
      return this.#passwords.replayResult(prior, input.deploymentId);
    }
    if (sessionId !== null) {
      if (!target?.live) return unavailable(site, "session-closed");
      if (!target.main) return unavailable(site, "main-browser-required");
      if (!target.signIn || !input.loginFill) return unavailable(site, "runtime-outdated");
    }
    const availability = await this.#passwords.probe(input.ownerId, site);
    if (availability !== "has-login") return unavailable(site, availabilityReason(availability));
    return this.#passwords.request({
      ...call,
      admitStart: () => this.#admit(input.runId, sessionId ?? input.deploymentId, site),
    });
  }

  /** Wakes the agent an offer belongs to, unless the person stopped it or its Run still waits on them. */
  #wake(offer: PasswordsOffer): Promise<PasswordsOfferOutcome> {
    const key = offerKey(offer.threadId, offer.site);
    const signIns = this.#signIns.get(key);
    return this.#inTurn(key, async () => {
      await signIns;
      if (!this.#offers.isCurrent(offer)) return "ended";
      if (await this.#stoppedByPerson(offer.threadId)) return "ended";
      // The Run's outcomes arrive together: a newer Run now would release them early.
      if (
        await this.#requests.hasPendingDurableRequest({ except: [], originatingRunId: offer.runId })
      )
        return "held";
      await this.#onLoginSaved(offer);
      return "ended";
    });
  }

  /** In-memory, so a restart forgets it; the admission ledger still bounds each Run. */
  #admit(runId: RunId, target: string, site: string): boolean {
    return admitSignIn(this.#calls, this.#now(), { runId, target, site });
  }

  /** Runs `operation` after every earlier operation with the same key settles. */
  #inTurn<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#turns.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#turns.set(key, settled);
    void settled.then(() => {
      if (this.#turns.get(key) === settled) this.#turns.delete(key);
    });
    return result;
  }
}

function offerKey(threadId: ThreadId, site: string): string {
  return `${threadId}\0${site}`;
}

function unavailable(site: string, reason: SavedLoginUnavailableReason): SavedLoginResult {
  return { status: "unavailable", site, reason };
}

function availabilityReason(
  availability: Exclude<PasswordSignInAvailability, "has-login">,
): SavedLoginUnavailableReason {
  switch (availability) {
    case "no-login":
      return "no-saved-login";
    case "off":
      return "passwords-off";
    case "not-set-up":
      return "passwords-not-set-up";
    case "unavailable":
      return "unsupported";
  }
}
