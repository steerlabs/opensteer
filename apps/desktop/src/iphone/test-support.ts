import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createId } from "@opensteer/core";
import {
  type IphoneNativeMessage,
  type iphoneNativeRosterSchema,
  type IphoneRunnerOwner,
} from "@opensteer/protocol/iphone-bridge";
import { openDesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";
import type { IphoneNativeTransport } from "./bridge-client.js";
import { IphoneStore } from "./iphone-store.js";
import { IphoneService } from "./iphone-service.js";
import type { IphoneMacSupport } from "./mac-support.js";

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
  calls: { method: string; params: unknown; timeoutMs?: number }[] = [];
  /** Like the real bridge, announce a new roster revision after every inspection. */
  echoInspections = false;
  closed = 0;
  readonly held = new Map<string, Promise<void>>();
  readonly failures = new Map<string, Error>();
  readonly identities = new Map<string, string>();
  epoch = 1;
  images: { build: string; version?: string | undefined }[] = [{ build: "test" }];
  inspection: z.infer<
    typeof import("@opensteer/protocol/iphone-bridge").iphoneNativeInspectionSchema
  > = {
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
  probeReady = true;
  control = false;
  displayDemandActive = true;
  foreground: { appId: string; label: string } | null = { appId: "example.app", label: "Example" };
  readonly listeners = new Set<(event: Extract<IphoneNativeMessage, { kind: "event" }>) => void>();
  readonly lost = new Set<() => void>();
  roster: z.infer<typeof iphoneNativeRosterSchema> = {
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
        trust: "trusted",
        reason: null,
      },
    ],
  };
  async request<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    this.calls.push({
      method,
      params,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    await this.held.get(method);
    const failure = this.failures.get(method);
    if (failure) throw failure;
    let value: unknown = {};
    switch (method) {
      case "images.refresh":
        value = { images: this.images };
        break;
      case "binding.release":
        this.roster = {
          revision: this.roster.revision + 1,
          candidates: this.roster.candidates.map(
            ({ capabilities: _capabilities, ...candidate }) => ({
              ...candidate,
              reason: null,
            }),
          ),
        };
        this.publish();
        break;
      case "binding.probe":
        if (this.probeReady) this.ready(false);
        break;
      case "roster.get":
      case "roster.subscribe":
        value = this.roster;
        break;
      case "phone.identity":
        value = {
          udid:
            this.identities.get((params as { candidateId: string }).candidateId) ??
            "synthetic-private-phone",
        };
        break;
      case "binding.acquire":
        value = { bindingToken: "binding" };
        break;
      case "session.open":
        this.control = (params as { access: string }).access === "control";
        this.ready(this.control);
        value = { localPhoneId: "candidate", nativeEpoch: this.epoch };
        break;
      case "session.close":
        this.control = false;
        this.ready(false);
        break;
      case "setup.inspect":
      case "setup.prepareDeveloperServices":
        value = this.inspection;
        if (this.echoInspections)
          setImmediate(() => {
            this.roster = { ...this.roster, revision: this.roster.revision + 1 };
            this.publish();
          });
        break;
      case "phone.observe":
        this.ready(this.control);
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
          foreground: this.foreground,
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
      case "phone.perform":
        value = { effect: "submitted", completedSteps: 1, observationRequired: true };
        break;
    }
    return schema.parse(value);
  }
  ready(control: boolean): void {
    this.roster = {
      revision: this.roster.revision + 1,
      candidates: this.roster.candidates.map((candidate) => ({
        ...candidate,
        reason: null,
        capabilities: {
          observe: null,
          act: control ? null : "qualification-required",
          launch: null,
          installedApps: null,
          text: "unsupported-text",
          clear: "unsupported-clear",
          indexedTargets: "geometry-unavailable",
          liveVideo: "unsupported",
        },
      })),
    };
    this.publish();
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
  publish(): void {
    for (const listener of this.listeners)
      listener({
        kind: "event",
        event: "roster.changed",
        bootId: "test-boot",
        sequence: this.roster.revision,
        roster: this.roster,
      });
  }
  async close(): Promise<void> {
    this.closed++;
    this.lose();
  }
}
export async function fixture(optionsInput?: { mac?: IphoneMacSupport }) {
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
      ...(optionsInput?.mac ? { mac: optionsInput.mac } : {}),
      startNative: async () => ({ client: native, images: [{ build: "test" }] }),
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
    const conn = service.forSlot(ownerA).connect(() => undefined);
    await conn.request(
      "iphone.targets",
      {
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

export class FakeIphoneMacSupport implements IphoneMacSupport {
  xcodeApps = ["/Applications/Xcode.app"];
  imageRoots = ["/synthetic/images"];
  xcodeInstalling = false;
  readonly listeners = new Set<() => void>();
  readonly helps: string[] = [];
  async inspect() {
    return {
      xcodeApps: this.xcodeApps,
      imageRoots: this.imageRoots,
      xcodeInstalling: this.xcodeInstalling,
    };
  }
  watch(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async help(action: string) {
    this.helps.push(action);
  }
  changed() {
    for (const listener of this.listeners) listener();
  }
}
