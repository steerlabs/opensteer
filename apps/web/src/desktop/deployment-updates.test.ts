import { createId } from "@opensteer/core";
import type { DesktopDeploymentUpdatesBridge } from "@opensteer/protocol/desktop";
import { expect, it, vi } from "vitest";
import { BridgeDesktopUpdates } from "./deployment-updates.js";

const deploymentId = createId("deployment");

it("raises a refusal the bridge carried as the same failure", async () => {
  const bridge = {
    status: async () => ({ ok: false, failure: "unsupported" }),
  } as unknown as DesktopDeploymentUpdatesBridge;
  await expect(new BridgeDesktopUpdates(bridge, deploymentId).status()).rejects.toMatchObject({
    reason: "unsupported",
  });
});

it("cancels the wait in the main process when the view closes", async () => {
  const cancel = vi.fn(async () => undefined);
  let answer: (value: { ok: false; failure: "unavailable" }) => void = () => undefined;
  const status = vi.fn(() => new Promise((resolve) => (answer = resolve)));
  const bridge = { cancel, status } as unknown as DesktopDeploymentUpdatesBridge;
  const closed = new AbortController();
  const pending = new BridgeDesktopUpdates(bridge, deploymentId).status({ signal: closed.signal });
  const reason = new Error("Updates view closed");
  closed.abort(reason);
  const [{ waitId }] = status.mock.calls[0] as unknown as [{ waitId: string }];
  expect(cancel).toHaveBeenCalledWith(waitId);
  answer({ ok: false, failure: "unavailable" });
  await expect(pending).rejects.toBe(reason);
});
