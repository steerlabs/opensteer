import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import type { PasswordSignInAvailability, SavedLoginResult } from "@opensteer/protocol";
import {
  PasswordsOffers,
  passwordsLoginSavedMessage,
  type PasswordsOffer,
  type PasswordsOfferOutcome,
} from "./passwords-offers.js";

const site = "https://brex.com";
const offered: SavedLoginResult = { reason: "passwords-not-set-up", site, status: "unavailable" };
const ready: SavedLoginResult = {
  account: "t•••@brex.com",
  loginRef: `lgn_${"0".repeat(32)}`,
  site,
  status: "ready",
};

function watch(options: { wake?: () => Promise<PasswordsOfferOutcome> } = {}) {
  const state = {
    answer: "has-login" as PasswordSignInAvailability,
    beforeAnswer: () => {},
    clock: 0,
    errors: [] as unknown[],
    woken: [] as PasswordsOffer[],
  };
  const offers = new PasswordsOffers({
    now: () => state.clock,
    onError: (error) => state.errors.push(error),
    probe: async () => {
      state.beforeAnswer();
      return state.answer;
    },
    wake: async (offer) => {
      state.woken.push(offer);
      return options.wake ? await options.wake() : "ended";
    },
  });
  const input = {
    ownerId: createId("user"),
    runId: createId("run"),
    tabId: null,
    site,
    threadId: createId("thread"),
  };
  return { input, offers, state };
}

describe("PasswordsOffers", () => {
  it("forgets an offer nobody acted on, so a moved-on Thread is never woken", async () => {
    const { input, offers, state } = watch();
    offers.note(input, offered);
    state.clock = 15 * 60_000;
    await offers.sweep();
    expect(state.woken).toEqual([]);
    offers.close();
  });

  it("keeps an offer through a failure that says nothing about Passwords", async () => {
    const { input, offers, state } = watch();
    offers.note(input, offered);
    offers.note(input, { reason: "rate-limited", site, status: "unavailable" });
    await offers.sweep();
    expect(state.woken).toHaveLength(1);
    offers.close();
  });

  it("drops the offer a newer sign-in replaced while its probe was out", async () => {
    const { input, offers, state } = watch();
    offers.note(input, offered);
    state.beforeAnswer = () => {
      offers.note(input, ready);
    };
    await offers.sweep();
    expect(state.woken).toEqual([]);
    offers.close();
  });

  it("asks again next pass when the wake is held, under the same id", async () => {
    let outcome: PasswordsOfferOutcome = "held";
    const { input, offers, state } = watch({ wake: async () => outcome });
    offers.note(input, offered);
    await offers.sweep();
    outcome = "ended";
    await offers.sweep();
    await offers.sweep();
    expect(state.woken.map(({ id }) => id)).toEqual([state.woken[0]?.id, state.woken[0]?.id]);
    offers.close();
  });

  it("wakes every offer one pass finds a login for", async () => {
    const { input, offers, state } = watch();
    offers.note(input, offered);
    offers.note({ ...input, site: "https://ramp.com" }, { ...offered, site: "https://ramp.com" });
    await offers.sweep();
    expect(state.woken.map((offer) => offer.site)).toEqual([site, "https://ramp.com"]);
    offers.close();
  });

  it("keeps a Thread's offers apart from another's", async () => {
    const { input, offers, state } = watch();
    offers.note(input, offered);
    offers.note({ ...input, threadId: createId("thread") }, offered);
    offers.note(input, ready);
    await offers.sweep();
    expect(state.woken).toHaveLength(1);
    expect(state.woken[0]?.threadId).not.toBe(input.threadId);
    offers.close();
  });
});

describe("what the agent reads", () => {
  it("states a fact and leaves the decision to the agent", () => {
    const message = passwordsLoginSavedMessage({
      id: "offer",
      ownerId: createId("user"),
      runId: createId("run"),
      tabId: "tab-fixture",
      site,
      threadId: createId("thread"),
    });
    expect(message).toContain(site);
    expect(message).toContain("tab-fixture");
    expect(message).toContain("use_saved_login again");
  });
});
