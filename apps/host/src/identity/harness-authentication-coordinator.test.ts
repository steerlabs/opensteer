import { createId, HarnessIdSchema, OpensteerError } from "@opensteer/core";
import type { HarnessAuthenticationState } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  HarnessAuthenticationCoordinator,
  type HarnessAuthenticationRunnerRegistry,
  type HarnessAuthenticationTarget,
} from "./harness-authentication-coordinator.js";

const environmentId = createId("environment");
const harnessInstanceId = createId("harnessInstance");
const driverKind = HarnessIdSchema.parse("codex");
const pending: HarnessAuthenticationState = {
  challenge: {
    kind: "device-code",
    userCode: "OPEN-STEER",
    verificationUrl: "https://example.test/device",
  },
  status: "pending",
};
const target: HarnessAuthenticationTarget = {
  environment: { id: environmentId, kind: "managed" },
  harness: {
    config: {},
    driverKind,
    id: harnessInstanceId,
    name: "Codex",
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "isolated",
  },
};
const signal = new AbortController().signal;
/** Every caller names an advertised setup method; there is no default. */
const selection = { methodId: "codex-device-code" } as const;

function coordinatorFixture(
  options: {
    readonly connected?: boolean;
    readonly maximumLifetimeMs?: number;
    readonly now?: number;
    readonly state?: HarnessAuthenticationState;
  } = {},
) {
  let connected = options.connected ?? false;
  let now = options.now ?? 1_000;
  let state = options.state ?? pending;
  let failure: unknown;
  let harnessInstance: (typeof target.harness & { readonly enabled: boolean }) | null = {
    ...target.harness,
    enabled: true,
  };
  const getHarnessInstance = vi.fn(async () => harnessInstance);
  const manageHarnessAuthentication = vi.fn(
    async (_environmentId, _request, _signal): Promise<HarnessAuthenticationState> => {
      if (failure) throw failure;
      return state;
    },
  );
  const runners: HarnessAuthenticationRunnerRegistry = {
    isAvailable: () => connected,
    manageHarnessAuthentication,
  };
  const coordinator = new HarnessAuthenticationCoordinator({
    harnesses: { getHarnessInstance },
    ...(options.maximumLifetimeMs === undefined
      ? {}
      : { maximumLifetimeMs: options.maximumLifetimeMs }),
    now: () => now,
    runners,
  });
  return {
    coordinator,
    getHarnessInstance,
    manageHarnessAuthentication,
    setConnected(value: boolean) {
      connected = value;
    },
    setFailure(value: unknown) {
      failure = value;
    },
    setHarnessInstance(value: (typeof target.harness & { readonly enabled: boolean }) | null) {
      harnessInstance = value;
    },
    setNow(value: number) {
      now = value;
    },
    setState(value: HarnessAuthenticationState) {
      state = value;
    },
  };
}

/** Exactly what RunnerRegistry raises when an environment has no connection. */
function runnerDetached(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "The selected Runner is not connected",
    retryable: true,
  });
}

describe("HarnessAuthenticationCoordinator", () => {
  it("keeps repeated ensures on one attempt with the original hard expiry", async () => {
    const fixture = coordinatorFixture({ maximumLifetimeMs: 1_000, now: 10_000 });

    await fixture.coordinator.ensure(target, signal, selection);
    fixture.setNow(10_500);
    await fixture.coordinator.ensure(target, signal, selection);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(true);

    fixture.setConnected(true);
    await fixture.coordinator.onRunnerConnected(environmentId);
    expect(fixture.manageHarnessAuthentication).toHaveBeenCalledTimes(1);

    // Neither the second POST nor registration moved the first POST's deadline.
    fixture.setNow(11_000);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
  });

  it("asks the Runner for a fresh challenge once an attempt has expired", async () => {
    const fixture = coordinatorFixture({
      connected: true,
      maximumLifetimeMs: 1_000,
      now: 10_000,
    });
    await expect(fixture.coordinator.ensure(target, signal, selection)).resolves.toMatchObject({
      authentication: { status: "pending" },
    });

    // Past the hard deadline the Runner discards its own interaction too, so
    // the next POST has to be a new start rather than a replay of a dead code
    // or a refusal the person cannot act on.
    fixture.setNow(11_500);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
    await expect(fixture.coordinator.ensure(target, signal, selection)).resolves.toMatchObject({
      authentication: { status: "pending" },
    });
    expect(
      fixture.manageHarnessAuthentication.mock.calls.map(([, request]) => request.action),
    ).toEqual(["start", "start"]);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(true);
  });

  it("moves waking attempts to pending and re-starts them on every registration", async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.ensure(target, signal, selection);
    fixture.setConnected(true);

    await fixture.coordinator.onRunnerConnected(environmentId);
    await fixture.coordinator.onRunnerConnected(environmentId);

    expect(fixture.getHarnessInstance).toHaveBeenCalledTimes(2);
    expect(fixture.manageHarnessAuthentication).toHaveBeenCalledTimes(2);
    expect(
      fixture.manageHarnessAuthentication.mock.calls.map(([, request]) => request.action),
    ).toEqual(["start", "start"]);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(true);
  });

  it("lazily prunes expired attempts without cancelling a live Runner flow", async () => {
    const fixture = coordinatorFixture({ maximumLifetimeMs: 100, now: 5_000 });
    await fixture.coordinator.ensure(target, signal, selection);

    fixture.setNow(5_100);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
    fixture.setConnected(true);
    await fixture.coordinator.onRunnerConnected(environmentId);
    expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
  });

  it("keeps GET pure whether or not a Runner is connected", async () => {
    const fixture = coordinatorFixture({ state: { status: "not-started" } });

    await expect(fixture.coordinator.read(target, signal)).resolves.toEqual({
      authentication: { status: "not-started" },
      environmentStatus: "disconnected",
    });
    expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);

    fixture.setConnected(true);
    await expect(fixture.coordinator.read(target, signal)).resolves.toEqual({
      authentication: { status: "not-started" },
      environmentStatus: "connected",
    });
    expect(fixture.manageHarnessAuthentication).toHaveBeenCalledTimes(1);
    expect(fixture.manageHarnessAuthentication.mock.calls[0]?.[1].action).toBe("read");
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
  });

  it("forwards secret input byte-for-byte without normalizing or retaining it", async () => {
    const fixture = coordinatorFixture({ connected: true });
    await fixture.coordinator.submit(target, "  sk-exact-value  ", signal);
    expect(fixture.manageHarnessAuthentication).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      {
        action: "submit",
        driverKind,
        harnessInstanceId,
        value: "  sk-exact-value  ",
      },
      signal,
    );
  });

  it("DELETE removes demand and forwards cancellation only while connected", async () => {
    const fixture = coordinatorFixture({ state: { status: "not-started" } });
    await fixture.coordinator.ensure(target, signal, selection);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(true);

    await fixture.coordinator.cancel(target, signal);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
    expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();

    await fixture.coordinator.ensure(target, signal, selection);
    fixture.setConnected(true);
    await fixture.coordinator.cancel(target, signal);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
    expect(fixture.manageHarnessAuthentication).toHaveBeenCalledTimes(1);
    expect(fixture.manageHarnessAuthentication.mock.calls[0]?.[1].action).toBe("cancel");
  });

  it("requires a live Runner and forwards exact profile removal", async () => {
    const fixture = coordinatorFixture({ state: { status: "not-started" } });
    await expect(fixture.coordinator.remove(target, signal)).rejects.toMatchObject({
      retryable: true,
    });
    expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();

    fixture.setConnected(true);
    await expect(fixture.coordinator.remove(target, signal)).resolves.toBeUndefined();
    expect(fixture.manageHarnessAuthentication.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "remove",
      harness: { id: harnessInstanceId },
    });

    fixture.setFailure(runnerDetached());
    await expect(fixture.coordinator.remove(target, signal)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("deletes terminal results observed from POST, GET, and registration nudges", async () => {
    const fixture = coordinatorFixture({ connected: true, state: { status: "ready" } });

    await fixture.coordinator.ensure(target, signal, selection);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);

    fixture.setConnected(false);
    fixture.setState(pending);
    await fixture.coordinator.ensure(target, signal, selection);
    fixture.setConnected(true);
    fixture.setState({ detail: "Sign-in was refused", status: "failed" });
    await fixture.coordinator.read(target, signal);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);

    fixture.setConnected(false);
    fixture.setState(pending);
    await fixture.coordinator.ensure(target, signal, selection);
    fixture.setConnected(true);
    fixture.setState({ status: "ready" });
    await fixture.coordinator.onRunnerConnected(environmentId);
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
  });

  it("drops demand when a registration nudge finds the AI engine gone", async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.ensure(target, signal, selection);
    fixture.setConnected(true);
    fixture.setHarnessInstance(null);

    await expect(fixture.coordinator.onRunnerConnected(environmentId)).rejects.toThrow(
      /no longer available/u,
    );
    // DELETE resolves its target through the AI engine that just vanished, so a
    // retained attempt here would be a keep-alive nobody could cancel.
    expect(fixture.coordinator.hasPendingAttempt(environmentId)).toBe(false);
  });

  it("reads a Runner that dropped mid-request as an absent computer", async () => {
    const fixture = coordinatorFixture({ connected: true });
    fixture.setFailure(runnerDetached());

    const detached = {
      authentication: { status: "not-started" },
      environmentStatus: "disconnected",
    };
    await expect(fixture.coordinator.ensure(target, signal, selection)).resolves.toEqual(detached);
    for (const operation of ["read", "cancel"] as const) {
      await expect(fixture.coordinator[operation](target, signal)).resolves.toEqual(detached);
    }

    // Anything that is not that race still reaches the caller.
    fixture.setFailure(new Error("Runner AI engine sign-in request timed out"));
    await expect(fixture.coordinator.ensure(target, signal, selection)).rejects.toThrow(
      /timed out/u,
    );
  });
});
