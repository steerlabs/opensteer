import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createId } from "@opensteer/core";
import {
  type IphoneNativeMessage,
  type IphoneRunnerOwner,
} from "@opensteer/protocol/iphone-bridge";
import { openDesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";
import type { IphoneNativeTransport } from "./bridge-client.js";
import { IphoneStore } from "./iphone-store.js";
import { IphoneService } from "./iphone-service.js";

const nativeFsTestBinary = path.resolve(
  import.meta.dirname,
  `../../../runner/native-fs-helper/opensteer-native-fs-test${process.platform === "win32" ? ".exe" : ""}`,
);
export const ownerA: IphoneRunnerOwner = {
  deploymentId: createId("deployment"),
  hostInstanceId: createId("hostInstance"),
  runnerId: createId("runner"),
};
export const ownerB: IphoneRunnerOwner = {
  deploymentId: createId("deployment"),
  hostInstanceId: createId("hostInstance"),
  runnerId: createId("runner"),
};
export class FakeIphoneNative implements IphoneNativeTransport {
  calls: { method: string; params: unknown }[] = [];
  closed = 0;
  readonly held = new Map<string, Promise<void>>();
  epoch = 1;
  readonly listeners = new Set<(event: Extract<IphoneNativeMessage, { kind: "event" }>) => void>();
  readonly lost = new Set<() => void>();
  roster = {
    revision: 1,
    candidates: [
      {
        localPhoneId: "candidate",
        nativeEpoch: 1,
        name: "Test phone",
        model: "iPhoneTest",
        osVersion: "27.0",
        build: "test",
        transport: "usb" as const,
        reason: "qualification-required" as const,
      },
    ],
  };
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    this.calls.push({ method, params });
    await this.held.get(method);
    let value: unknown = {};
    switch (method) {
      case "roster.get":
      case "roster.subscribe":
        value = this.roster;
        break;
      case "phone.identity":
        value = { udid: "synthetic-private-phone" };
        break;
      case "binding.acquire":
        value = { bindingToken: "binding" };
        break;
      case "session.open":
        value = { localPhoneId: "candidate", nativeEpoch: this.epoch };
        break;
      case "setup.inspect":
      case "setup.prepareDeveloperServices":
        value = {
          pairing: "paired",
          developerMode: "enabled",
          name: "Test phone",
          model: "iPhoneTest",
          osVersion: "27.0",
          build: "test",
          image: "mounted",
          tunnel: "ready",
          lock: "unknown",
          reason: "qualification-required",
        };
        break;
      case "phone.observe":
        value = {
          nativeEpoch: this.epoch,
          observationToken: "observation",
          geometryRevision: 1,
          geometry: {
            width: 100,
            height: 200,
            captureWidth: 100,
            captureHeight: 200,
            displayId: 0,
            rotation: 0,
          },
          state: { lock: "unlocked", display: "on", rotation: 0, displayId: 0 },
          foreground: null,
          coverage: {
            coordinateSpace: "unqualified",
            status: "partial",
            reason: "quiet-window",
            received: 0,
            returned: 0,
            missingFrames: 0,
            missingChildren: 0,
            unreturned: 0,
            cycles: 0,
            truncated: false,
          },
          buttons: ["home"],
          textReason: "unsupported-text",
          clearReason: "unsupported-clear",
          nodes: [],
          screenshot: { mimeType: "image/jpeg", base64: "test", width: 100, height: 200 },
        };
        break;
    }
    return schema.parse(value);
  }
  onEvent(listener: Parameters<IphoneNativeTransport["onEvent"]>[0]): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onLost(listener: () => void): () => void {
    this.lost.add(listener);
    return () => {
      this.lost.delete(listener);
    };
  }
  lose(): void {
    for (const listener of this.lost) listener();
  }
  async close(): Promise<void> {
    this.closed++;
    this.lose();
  }
}
export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-iphone-service-"));
  const files = await openDesktopPrivateFilesystem({
    binary: nativeFsTestBinary,
    root: path.join(root, "private"),
  });
  let fail = false;
  const atomic = files.writeFileAtomic.bind(files);
  files.writeFileAtomic = async (...args) => {
    if (fail && args[0].endsWith("mappings.v1.json")) {
      fail = false;
      throw new Error("synthetic write failed");
    }
    await atomic(...args);
  };
  const store = new IphoneStore(files);
  const native = new FakeIphoneNative();
  const services: IphoneService[] = [];
  const restart = () => {
    const service = new IphoneService({
      store,
      startNative: async () => ({ client: native, images: [{ handle: "image", build: "test" }] }),
    });
    services.push(service);
    return service;
  };
  const service = restart();
  await service.discover();
  const deviceId = createId("device");
  const options = () => ({ deadline: Date.now() + 10000 });
  const bind = async () => {
    const record = await service.reserve(ownerA, "candidate", crypto.randomUUID());
    await service.finishSetup(record);
    await service.save({ ...record, phase: "bound", deviceId, driverGeneration: 1 });
    const conn = service.forSlot(ownerA.deploymentId).connect(() => undefined);
    await conn.request(
      "iphone.targets",
      {
        ...ownerA,
        assignments: [{ deviceId, generation: 1, role: "screen", definitionId: "iphone-screen" }],
      },
      options(),
    );
  };
  const peer = async (name = "peer") => {
    const peerFiles = await openDesktopPrivateFilesystem({
      binary: nativeFsTestBinary,
      root: path.join(root, name),
    });
    const peerService = new IphoneService({
      store: new IphoneStore(peerFiles, files),
      startNative: async () => ({ client: new FakeIphoneNative(), images: [] }),
    });
    services.push(peerService);
    await peerService.discover();
    return peerService;
  };
  return {
    peer,
    service,
    store,
    native,
    deviceId,
    options,
    bind,
    restart,
    failWrite: () => {
      fail = true;
    },
    cleanup: async () => {
      await Promise.all(services.map((s) => s.stop()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
