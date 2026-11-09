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
  const flow = startAccountSignIn({
    client,
    target: { kind: "create", request },
    errorMessage: String,
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.getState()).toMatchObject({
      kind: "signing-in",
      session: { view: { kind: "pending", userCode: "DEMO-1234" } },
    });
    await client.dispatch(request);
    expect(client.getSnapshot().harnesses).toHaveLength(initial.harnesses.length + 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(
      () =>
        expect(
          flow.getState(),
          "mock sign-in never published its ready account catalog",
        ).toMatchObject({ kind: "duplicate", accountLabel: "demo@opensteer.test" }),
      { timeout: 1_000 },
    );
    await flow.removeDuplicate();
    expect(flow.getState()).toEqual({ kind: "cancelled" });
    expect(client.getSnapshot().harnesses).toHaveLength(initial.harnesses.length);
    expect(
      client
        .getSnapshot()
        .environments.flatMap((item) => item.harnessCatalogs)
        .some(
          (item) => !initial.harnesses.some((harness) => harness.id === item.harnessInstanceId),
        ),
    ).toBe(false);
  } finally {
    await flow.cancel();
    client.dispose();
  }
});
