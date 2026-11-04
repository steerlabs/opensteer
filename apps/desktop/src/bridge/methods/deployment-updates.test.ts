import { DesktopUpdatesError, type DesktopUpdates } from "@opensteer/client/connections";
import { createId } from "@opensteer/core";
import type { IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import type { DesktopBridgeContext } from "../context.js";
import { deploymentUpdatesHandlers } from "./deployment-updates.js";

const token = "b".repeat(43);
const deploymentId = createId("deployment");
const waitId = crypto.randomUUID();

function handlers(status: DesktopUpdates["status"]) {
  const updates = vi.fn(() => ({ status }) as unknown as DesktopUpdates);
  const context = { options: { bridgeToken: token, deploymentUpdates: updates } };
  return {
    updates,
    handler: new Map(deploymentUpdatesHandlers(context as unknown as DesktopBridgeContext)),
  };
}

function event(url = "app://opensteer/index.html"): IpcMainInvokeEvent {
  const mainFrame = { url };
  return { sender: { mainFrame }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

it("refuses a renderer that is not the application before reaching any Deployment", async () => {
  const { handler, updates } = handlers(async () => {
    throw new Error("Unreachable.");
  });
  await expect(
    Promise.resolve().then(() =>
      handler.get(desktopBridgeChannels.deploymentUpdateStatus)!(
        event("https://attacker.invalid"),
        { bridgeToken: token, input: { deploymentId, waitId } },
      ),
    ),
  ).rejects.toThrow(/bundled Opensteer application/iu);
  expect(updates).not.toHaveBeenCalled();
});

it("carries a Host's refusal across the bridge as its reason", async () => {
  const { handler } = handlers(async () => {
    throw new DesktopUpdatesError("unsupported");
  });
  await expect(
    handler.get(desktopBridgeChannels.deploymentUpdateStatus)!(event(), {
      bridgeToken: token,
      input: { deploymentId, waitId },
    }),
  ).resolves.toEqual({ ok: false, failure: "unsupported" });
});

it("cancels the long wait a closed view left behind", async () => {
  const signals: AbortSignal[] = [];
  const { handler } = handlers(
    (options) =>
      new Promise((_resolve, reject) => {
        signals.push(options!.signal!);
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason));
      }),
  );
  const pending = handler.get(desktopBridgeChannels.deploymentUpdateStatus)!(event(), {
    bridgeToken: token,
    input: { deploymentId, waitId },
  });
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  await handler.get(desktopBridgeChannels.deploymentUpdateCancel)!(event(), {
    bridgeToken: token,
    input: waitId,
  });
  expect(signals[0]!.aborted).toBe(true);
  await expect(pending).resolves.toEqual({ ok: false, failure: "unavailable" });
});
