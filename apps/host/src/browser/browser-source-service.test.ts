import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import type { PasswordSignInAvailability } from "@opensteer/protocol";
import { gate } from "@opensteer/shared/test-support/observation";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSourceService } from "./browser-source-service.js";
import { PasswordsOffers, type PasswordsOffer } from "./passwords-offers.js";

const site = "https://offer.test";
type ServiceOptions = ConstructorParameters<typeof BrowserSourceService>[0];

function deadline<T>(operation: Promise<T>, label: string): Promise<T> {
  return withTimeout(operation, 1_000, {
    timeoutError: () => new Error(`${label} did not finish`),
  });
}

function scene() {
  const state = {
    availability: "no-login" as PasswordSignInAvailability,
    woken: [] as PasswordsOffer[],
  };
  const requests = {
    findByCallIdentity: vi.fn(async () => null),
    hasPendingDurableRequest: vi.fn(async () => false),
  };
  const passwords = {
    join: () => null,
    probe: vi.fn(async () => state.availability),
    request: vi.fn(async () => ({
      replayed: false,
      requestId: createId("request"),
      status: "pending" as const,
    })),
  };
  const onLoginSaved = vi.fn(async (offer: PasswordsOffer) => {
    state.woken.push(offer);
  });
  const onError = vi.fn();
  const service = new BrowserSourceService({
    browser: {} as ServiceOptions["browser"],
    canonicalOrigin: "https://opensteer.test",
    currentRoute: async () => null,
    onError,
    onLoginSaved,
    onRequestResolved: () => {},
    onWorkspaceEvent: () => {},
    passwords: passwords as unknown as ServiceOptions["passwords"],
    requests: requests as unknown as ServiceOptions["requests"],
    sign: () => "unused",
    stoppedByPerson: async () => false,
    store: {} as ServiceOptions["store"],
  });
  const input = {
    callId: randomUUID(),
    ownerId: createId("user"),
    reason: "Sign in",
    runId: createId("run"),
    site,
    threadId: createId("thread"),
    workspaceId: createId("workspace"),
  };
  return { input, onError, onLoginSaved, passwords, requests, service, state };
}

describe("saved-login wakes racing sign_in", () => {
  let ready: ReturnType<typeof scene>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ready = scene();
    expect(await deadline(ready.service.agentSignIn(ready.input), "Initial sign-in")).toEqual({
      reason: "no-saved-login",
      site,
      status: "unavailable",
    });
    ready.state.availability = "has-login";
  });

  afterEach(() => {
    ready.service.close();
    vi.useRealTimers();
    expect(ready.onError).not.toHaveBeenCalled();
  });

  it("does not wake an older offer while a newer sign-in is making progress", async () => {
    const sweep = vi.spyOn(PasswordsOffers.prototype, "sweep");
    const admission = gate({ label: "New sign-in admission", deadlineMs: 1_000 });
    ready.requests.findByCallIdentity.mockImplementationOnce(async () => {
      await deadline(admission.enter(), "Release sign-in admission");
      return null;
    });
    const signIn = ready.service.agentSignIn({ ...ready.input, callId: randomUUID() });
    try {
      await admission.entered;
      await deadline(vi.advanceTimersByTimeAsync(3_000), "Offer sweep timer");
      expect(ready.state.woken).toEqual([]);
    } finally {
      admission.release();
      await deadline(signIn, "New sign-in");
      await deadline(
        Promise.all(sweep.mock.results.map(({ value }) => value)),
        "Timer's offer sweeps",
      );
    }
    await deadline(vi.advanceTimersByTimeAsync(3_000), "Next offer sweep timer");
    expect(ready.state.woken).toEqual([]);
    expect(ready.passwords.request).toHaveBeenCalledOnce();
  });

  it("finishes an in-flight wake before a newer sign-in can supersede its offer", async () => {
    const delivery = gate({ label: "Saved-login delivery", deadlineMs: 1_000 });
    const order: string[] = [];
    ready.onLoginSaved.mockImplementationOnce(async (offer) => {
      await deadline(delivery.enter(), "Release saved-login delivery");
      ready.state.woken.push(offer);
      order.push("wake delivered");
    });
    const sweep = ready.service.sweepPasswordsOffers();
    let signIn: Promise<unknown> | undefined;
    try {
      await delivery.entered;
      signIn = ready.service.agentSignIn({ ...ready.input, callId: randomUUID() }).then(() => {
        order.push("sign-in finished");
      });
      await deadline(vi.advanceTimersByTimeAsync(0), "Queued sign-in turn");
    } finally {
      delivery.release();
      await deadline(Promise.all([sweep, signIn]), "Delivery and sign-in turns");
    }
    expect(order).toEqual(["wake delivered", "sign-in finished"]);
    await deadline(ready.service.sweepPasswordsOffers(), "Subsequent sweep");
    expect(ready.state.woken).toHaveLength(1);
  });
});
