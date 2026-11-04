import { expect, it, vi } from "vitest";
import { MockHostClient } from "./mock-host-client.js";
import { MockDesktopUpdates, type MockDesktopUpdateScenario } from "./mock-desktop-updates.js";

it.each([
  "idle",
  "available",
  "in-progress",
  "succeeded",
  "failed",
  "unsupported",
  "offline",
] as const)(
  "mock Host supplies the %s maintenance state",
  async (scenario: MockDesktopUpdateScenario) => {
    const host = new MockHostClient({ desktopUpdates: scenario });
    try {
      if (scenario === "offline") {
        await expect(host.desktopUpdates.status()).rejects.toMatchObject({ reason: "offline" });
        return;
      }
      const status = await host.desktopUpdates.status();
      expect(status.supported).toBe(scenario !== "unsupported");
      if (["succeeded", "failed"].includes(scenario))
        expect(status.operation?.state).toBe(scenario);
      if (scenario === "in-progress") expect(status.operation?.state).toBe("staged");
      if (scenario === "available") expect(status.state?.status).toBe("available");
    } finally {
      host.dispose();
    }
  },
);

it("replays intent, rejects competing updates, and stops notifying a hidden view", async () => {
  const updates = new MockDesktopUpdates("available");
  const controller = new AbortController();
  const listener = vi.fn();
  updates.subscribeWhileVisible(listener, { signal: controller.signal, onError: () => {} });
  const request = { idempotencyKey: "once", intent: { action: "update" as const } };
  const operation = await updates.request(request);
  expect(await updates.request(request)).toEqual(operation);
  await expect(updates.request({ ...request, idempotencyKey: "other" })).rejects.toMatchObject({
    reason: "conflict",
  });
  await expect(
    updates.request({ ...request, intent: { action: "channel", channel: "beta" } }),
  ).rejects.toMatchObject({ reason: "conflict" });
  controller.abort();
  const count = listener.mock.calls.length;
  updates.setScenario("succeeded");
  expect(listener).toHaveBeenCalledTimes(count);
  expect((await updates.status()).operation?.state).toBe("succeeded");
});
