import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, ownerA, ownerB } from "../../iphone/test-support.js";
import { IphoneSetup } from "../../iphone/iphone-setup.js";
import type { DesktopBridgeContext } from "../context.js";
import { iphoneHandlers } from "./iphone.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
it("authorizes every setup method, binds candidates to one renderer, and cancels navigation and slot changes", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const connection = f.service.forSlot(ownerA).connect(() => undefined);
  await connection.request("iphone.targets", { assignments: [] }, f.options());
  const setup = new IphoneSetup(f.service);
  const sender = Object.assign(new EventEmitter(), {
    mainFrame: { url: "app://opensteer/index.html" },
    isDestroyed: () => false,
    send: vi.fn(),
  }) as unknown as WebContents;
  const other = Object.assign(new EventEmitter(), {
    mainFrame: { url: "app://opensteer/index.html" },
    isDestroyed: () => false,
    send: vi.fn(),
  }) as unknown as WebContents;
  const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
  let selected = ownerA.deploymentId;
  let changed: ((snapshot: DeploymentAccessSnapshot) => void) | undefined;
  const context = {
    options: {
      bridgeToken: "private-capability",
      iphone: { service: f.service, setup },
      access: {
        snapshot: () => ({ selectedDeploymentId: selected }),
        subscribe: (listener: (snapshot: DeploymentAccessSnapshot) => void) => {
          changed = listener;
          return () => undefined;
        },
      },
    },
  } as unknown as DesktopBridgeContext;
  const registered = iphoneHandlers(context);
  cleanups.push(async () => registered.dispose());
  const handlers = new Map(registered.handlers);
  for (const handler of handlers.values())
    await expect(
      Promise.resolve().then(() => handler(event, { bridgeToken: "forged", input: {} })),
    ).rejects.toThrow("capability");
  const call = (channel: string, input: unknown, source = event) =>
    handlers.get(channel)!(source, { bridgeToken: "private-capability", input });
  const state = (await call(desktopBridgeChannels.iphoneSetupBegin, {
    deploymentId: ownerA.deploymentId,
  })) as { setupId: string; candidates: { candidateId: string }[] };
  expect(JSON.stringify(state)).not.toContain("synthetic-private-phone");
  await expect(
    Promise.resolve().then(() =>
      call(
        desktopBridgeChannels.iphoneSetupChoose,
        { setupId: state.setupId, candidateId: state.candidates[0]!.candidateId },
        { sender: other, senderFrame: other.mainFrame } as IpcMainInvokeEvent,
      ),
    ),
  ).rejects.toMatchObject({ code: "cancelled" });
  sender.emit("did-start-navigation");
  await expect(setup.status(state.setupId)).rejects.toMatchObject({ code: "cancelled" });
  const next = (await call(desktopBridgeChannels.iphoneSetupBegin, {
    deploymentId: ownerA.deploymentId,
  })) as { setupId: string };
  selected = ownerB.deploymentId;
  changed!({ selectedDeploymentId: selected } as DeploymentAccessSnapshot);
  await expect(setup.status(next.setupId)).rejects.toMatchObject({ code: "cancelled" });
  connection.close();
});
