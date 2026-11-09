import { afterEach, expect, it, vi } from "vitest";
import { startAccountSignIn } from "../host/harness-authentication.js";
import { MockHostClient } from "./mock-host-client.js";

afterEach(() => {
  vi.useRealTimers();
});

it("walks an idempotent account create through a device challenge and duplicate removal", async () => {
  vi.useFakeTimers();
  const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
  const initial = client.getSnapshot();
  const account = initial.harnesses.find((item) => item.driverKind === "codex")!;
  const request = {
    type: "harness.create",
    environmentId: account.environmentId,
    driverKind: account.driverKind,
    sourceId: account.sourceId,
    name: "Codex 3",
    stateKind: "isolated",
    idempotencyKey: "mock-account-sign-in",
  } as const;
  const first = startAccountSignIn({
    client,
    target: { kind: "create", request },
    errorMessage: String,
  });
  const second = () =>
    startAccountSignIn({
      client,
      target: { kind: "create", request: { ...request, idempotencyKey: "mock-again", name: "Codex 4" } },
      errorMessage: String,
    });
  let flow = first;
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.getState()).toMatchObject({
      kind: "signing-in",
      session: { view: { kind: "pending", userCode: "DEMO-1234" } },
    });
    await client.dispatch(request);
    expect(client.getSnapshot().harnesses).toHaveLength(initial.harnesses.length + 1);
    await vi.advanceTimersByTimeAsync(9_500);
    await vi.waitFor(
      () =>
        expect(flow.getState(), "mock sign-in never finished").toMatchObject({
          kind: "done",
          accountLabel: "side@opensteer.test",
        }),
      { timeout: 1_000 },
    );
    flow = second();
    await vi.advanceTimersByTimeAsync(9_500);
    await vi.waitFor(
      () =>
        expect(flow.getState(), "the same account was never flagged").toMatchObject({
          kind: "duplicate",
          accountLabel: "side@opensteer.test",
        }),
      { timeout: 1_000 },
    );
    await flow.removeDuplicate();
    expect(flow.getState()).toEqual({ kind: "cancelled" });
    expect(client.getSnapshot().harnesses).toHaveLength(initial.harnesses.length + 1);
  } finally {
    await flow.cancel();
    client.dispose();
  }
});
