import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, ownerA, ownerB, FakeIphoneMacSupport } from "../../iphone/test-support.js";
import { IphoneSetup } from "../../iphone/iphone-setup.js";
import type { DesktopBridgeContext } from "../context.js";
import { iphoneHandlers } from "./iphone.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import type { DeploymentAccessSnapshot } from "@opensteer/protocol/desktop";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("authorizes every setup method, binds candidates to one renderer, and cancels navigation and slot changes", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const connection = f.service.forSlot(ownerA).connect(() => undefined);
  await connection.request("iphone.targets", { assignments: [] }, f.options());
  const setup = new IphoneSetup(f.service, new FakeIphoneMacSupport());
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
  cleanups.push(async () => {
    registered.dispose();
    await setup.stop();
  });
  const handlers = new Map(registered.handlers);
  for (const handler of handlers.values())
    await expect(
      Promise.resolve().then(() => handler(event, { bridgeToken: "forged", input: {} })),
    ).rejects.toThrow("capability");
  const call = (channel: string, input: unknown, source = event) =>
    handlers.get(channel)!(source, { bridgeToken: "private-capability", input });
  const saved = await f.service.reserve(ownerA, "candidate", crypto.randomUUID());
  await f.service.save({
    ...saved,
    phase: "pending-attach",
    attachTarget: { kind: "new", name: "Saved" },
  });
  const discovering = Promise.withResolvers<void>();
  f.native.held.set("roster.get", discovering.promise);
  const first = call(desktopBridgeChannels.iphoneSetupBegin, { deploymentId: ownerA.deploymentId });
  const second = call(desktopBridgeChannels.iphoneSetupBegin, {
    deploymentId: ownerA.deploymentId,
  });
  const begins = Promise.all([first, second]);
  discovering.resolve();
  const [resumed, duplicate] = await begins;
  expect(resumed).toEqual(duplicate);
  await vi.waitFor(
    async () => expect(await setup.status(saved.setupId)).toMatchObject({ stage: "add" }),
    { timeout: 1000 },
  );
  expect(
    await call(desktopBridgeChannels.iphoneSetupBegin, { deploymentId: ownerA.deploymentId }),
  ).toMatchObject({ setupId: saved.setupId, stage: "add" });
  sender.emit("did-start-navigation");
  await expect(setup.status(saved.setupId)).rejects.toMatchObject({ code: "cancelled" });
  await setup.cancel(saved.setupId);
  await f.store.remove(saved);
  const state = (await call(desktopBridgeChannels.iphoneSetupBegin, {
    deploymentId: ownerA.deploymentId,
  })) as { setupId: string; candidates: { candidateId: string }[] };
  expect(JSON.stringify(state)).not.toContain("synthetic-private-phone");
  await expect(
    Promise.resolve().then(() =>
      call(
        desktopBridgeChannels.iphoneSetupChoose,
        { setupId: state.setupId, candidateId: crypto.randomUUID() },
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
