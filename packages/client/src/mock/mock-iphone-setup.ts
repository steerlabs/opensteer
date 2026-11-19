import { DeploymentIdSchema, RunnerIdSchema } from "@opensteer/core";
import {
  IphoneScreenAttachResultSchema,
  type IphoneScreenAttachCommand,
} from "@opensteer/protocol";
import type {
  DesktopIphoneSetupStatus,
  DesktopIphoneSetupBridge,
} from "@opensteer/protocol/desktop";
import { createIphoneSetupPort, type IphoneSetupPort } from "../host/iphone-setup.js";

type Status = DesktopIphoneSetupStatus;
type Candidate = Status["candidates"][number];

const deploymentId = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001");

export const mockIphoneSetupCandidates = {
  sam: {
    trust: "trusted",
    candidateId: "33333333-3333-4333-8333-333333333333",
    name: "Sam’s iPhone",
    model: "iPhone 17 Pro",
    osVersion: "27.1",
    reason: null,
  },
  // A phone that hasn't trusted this Mac yet tells it nothing but that it's an iPhone.
  untrusted: {
    trust: "untrusted",
    candidateId: "44444444-4444-4444-8444-444444444444",
    name: "iPhone",
    model: "",
    osVersion: "",
    reason: null,
  },
  checking: {
    trust: "checking",
    candidateId: "66666666-6666-4666-8666-666666666666",
    name: "iPhone",
    model: "",
    osVersion: "",
    reason: null,
  },
  old: {
    trust: "trusted",
    candidateId: "55555555-5555-4555-8555-555555555555",
    name: "Kitchen iPhone",
    model: "iPhone 12",
    osVersion: "26.4",
    reason: "unsupported-ios",
  },
} as const satisfies Record<string, Candidate>;

const sam = mockIphoneSetupCandidates.sam;
const phone = { name: sam.name, model: sam.model, osVersion: sam.osVersion };

/** Every state the setup dialog can show, by name, in the order a setup reaches them. */
export const mockIphoneSetupScenes = {
  "mac-checking": { stage: "mac", state: "working" },
  "xcode-missing": { stage: "mac", state: "waiting", reason: "xcode-missing", action: "get-xcode" },
  "xcode-installing": { stage: "mac", state: "waiting", reason: "xcode-installing" },
  "xcode-setup": {
    stage: "mac",
    state: "waiting",
    reason: "xcode-setup-required",
    action: "open-xcode",
  },
  "plug-in": { stage: "connect", state: "waiting", reason: "no-phone" },
  choose: {
    stage: "connect",
    state: "decide",
    action: "choose-phone",
    candidates: [
      mockIphoneSetupCandidates.sam,
      mockIphoneSetupCandidates.untrusted,
      mockIphoneSetupCandidates.old,
    ],
  },
  "choose-checking": {
    stage: "connect",
    state: "decide",
    action: "choose-phone",
    candidates: [mockIphoneSetupCandidates.checking],
  },
  connecting: { stage: "connect", state: "working", phone },
  trust: { stage: "trust", state: "waiting", reason: "trust-required", phone },
  "trust-denied": { stage: "trust", state: "waiting", reason: "trust-denied", phone },
  "developer-mode": {
    stage: "developer-mode",
    state: "waiting",
    reason: "developer-mode-required",
    phone,
  },
  restarting: { stage: "developer-mode", state: "waiting", reason: "waiting-for-phone", phone },
  preparing: { stage: "prepare", state: "working", phone },
  "xcode-update": {
    stage: "prepare",
    state: "waiting",
    reason: "developer-image-incompatible",
    action: "get-xcode",
    phone,
  },
  "prepare-failed": {
    stage: "prepare",
    state: "blocked",
    reason: "developer-image-mount-failed",
    action: "retry",
    phone,
  },
  wifi: { stage: "wifi", state: "decide", action: "choose-wifi", phone },
  "wifi-local-network": {
    stage: "wifi",
    state: "waiting",
    reason: "local-network-permission-required",
    action: "open-local-network",
    phone,
  },
  name: {
    stage: "add",
    state: "decide",
    action: "name-phone",
    phone,
    suggestedName: "Sam’s iPhone 17 Pro",
  },
  adding: { stage: "add", state: "working", phone, suggestedName: "Sam’s iPhone 17 Pro" },
  finishing: {
    stage: "add",
    state: "waiting",
    reason: "assignment-pending",
    phone,
    suggestedName: "Sam’s iPhone 17 Pro",
  },
  "add-failed": {
    stage: "add",
    state: "blocked",
    reason: "host-offline",
    action: "retry",
    phone,
    suggestedName: "Sam’s iPhone 17 Pro",
  },
  broken: {
    stage: "mac",
    state: "blocked",
    reason: "bridge-protocol-mismatch",
    action: "start-over",
  },
  done: { stage: "done", state: "done", phone },
} as const satisfies Record<string, Partial<Status>>;
export type MockIphoneSetupScene = keyof typeof mockIphoneSetupScenes;

/** Where a setup moves next when nobody stands in its way, and how long it takes to get there. */
const journey: readonly (readonly [MockIphoneSetupScene, MockIphoneSetupScene, number])[] = [
  ["mac-checking", "plug-in", 900],
  ["xcode-installing", "xcode-setup", 4000],
  ["xcode-setup", "plug-in", 3000],
  ["plug-in", "choose", 2200],
  ["connecting", "trust", 900],
  ["trust", "developer-mode", 3500],
  ["trust-denied", "trust", 3500],
  ["developer-mode", "restarting", 4500],
  ["restarting", "preparing", 3500],
  ["preparing", "wifi", 2000],
  ["wifi-local-network", "name", 3000],
  ["finishing", "done", 1500],
];

export interface MockIphoneSetupPort extends IphoneSetupPort {
  /** Moves the setup to a new status, as desktop main would, and tells every subscriber. */
  push(patch: Partial<Status>): Status;
  /** Moves the setup to one of the named states. */
  show(scene: MockIphoneSetupScene): Status;
  readonly current: Status | null;
}

/**
 * The Mac's iPhone setup, in memory: what web mock mode, visual captures and
 * dialog tests drive. With `autoplay` it plays a whole setup, standing in for
 * the person's moves on the iPhone; without it, it moves only when told to
 * (`push`, `show`) or when the person decides something in the dialog.
 */
export function createMockIphoneSetupPort(
  options: {
    readonly start?: MockIphoneSetupScene;
    readonly autoplay?: boolean;
    /** The Host the finished setup adds the iPhone to; without it, adding answers a made-up result. */
    readonly dispatch?: (command: IphoneScreenAttachCommand) => Promise<unknown>;
    readonly driverRunnerId?: string;
  } = {},
): MockIphoneSetupPort {
  const listeners = new Map<string, Set<(status: Status) => void>>();
  let current: Status | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wifiEnabled = false;
  const driverRunnerId = RunnerIdSchema.parse(
    options.driverRunnerId ?? "rnr_33333333-3333-4333-8333-333333333333",
  );

  function blank(setupId: string, target: Status["target"]): Status {
    return {
      setupId,
      revision: 1,
      deploymentId,
      stage: "mac",
      state: "working",
      reason: null,
      action: "none",
      candidates: [],
      phone: null,
      suggestedName: null,
      attachCommand: null,
      target,
      deviceId: null,
      driverGeneration: null,
      wifiEnabled: false,
    };
  }

  function push(patch: Partial<Status>): Status {
    if (!current) throw new Error("No iPhone setup is running.");
    current = { ...current, ...patch, revision: current.revision + 1 };
    const shown = current;
    for (const listener of listeners.get(shown.setupId) ?? []) listener(shown);
    schedule();
    return shown;
  }

  function show(scene: MockIphoneSetupScene): Status {
    const base = current ?? blank(crypto.randomUUID(), null);
    const shape: Partial<Status> = mockIphoneSetupScenes[scene];
    const pending = base.attachCommand;
    const plugged = shape.stage !== "mac" && shape.stage !== "connect";
    current = {
      ...blank(base.setupId, base.target),
      revision: base.revision,
      deviceId: base.deviceId,
      driverGeneration: base.driverGeneration,
      candidates: plugged ? [sam] : [],
      ...shape,
      ...(scene === "add-failed"
        ? {
            attachCommand: pending ?? {
              type: "iphone.screen.attach" as const,
              idempotencyKey: `mock-iphone-setup:${base.setupId}`,
              driverRunnerId,
              target: base.target ?? {
                kind: "new" as const,
                name: shape.suggestedName ?? "iPhone",
              },
            },
          }
        : {}),
      wifiEnabled,
    };
    return push({});
  }

  function sceneOf(status: Status): MockIphoneSetupScene | null {
    const found = (Object.keys(mockIphoneSetupScenes) as MockIphoneSetupScene[]).find((scene) => {
      const shape: Partial<Status> = mockIphoneSetupScenes[scene];
      return (
        shape.stage === status.stage &&
        shape.state === status.state &&
        (shape.reason ?? null) === status.reason
      );
    });
    return found ?? null;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!options.autoplay || !current) return;
    const step = journey.find(([from]) => from === sceneOf(current!));
    if (!step) return;
    timer = setTimeout(() => show(step[1]), step[2]);
  }

  function owned(setupId: string): Status {
    if (!current || current.setupId !== setupId) throw new Error("no-session");
    return current;
  }

  async function add(input: { setupId: string; name?: string }): Promise<Status> {
    const status = owned(input.setupId);
    if (
      status.attachCommand?.target.kind === "new" &&
      input.name !== undefined &&
      status.attachCommand.target.name !== input.name.trim()
    )
      return push({ state: "blocked", reason: "attach-conflict", action: "retry" });
    const target = status.attachCommand?.target ??
      status.target ?? {
        kind: "new" as const,
        name: input.name ?? status.suggestedName ?? "iPhone",
      };
    show("adding");
    return push({
      attachCommand: {
        type: "iphone.screen.attach",
        idempotencyKey: `mock-iphone-setup:${input.setupId}`,
        driverRunnerId,
        target,
      },
    });
  }

  const platform: DesktopIphoneSetupBridge = {
    begin: async ({ target }) => {
      current = blank(crypto.randomUUID(), target ?? null);
      return show(options.start ?? "mac-checking");
    },
    subscribe: ({ setupId }, listener) => {
      const set = listeners.get(setupId) ?? new Set();
      set.add(listener);
      listeners.set(setupId, set);
      return () => set.delete(listener);
    },
    status: async ({ setupId }) => owned(setupId),
    cancel: async ({ setupId }) => {
      if (current?.setupId !== setupId) return;
      if (timer) clearTimeout(timer);
      timer = null;
      listeners.delete(setupId);
      current = null;
    },
    choose: async ({ setupId, candidateId }) => {
      const status = owned(setupId);
      const chosen = status.candidates.find((candidate) => candidate.candidateId === candidateId);
      if (!chosen) throw new Error("candidate-gone");
      show("connecting");
      return push({
        phone: { name: chosen.name, model: chosen.model, osVersion: chosen.osVersion },
      });
    },
    help: async ({ setupId, action }) => {
      const status = owned(setupId);
      return action === "get-xcode" && status.stage === "mac" ? show("xcode-installing") : status;
    },
    retry: async ({ setupId }) => {
      const status = owned(setupId);
      if (status.stage === "add" && !status.deviceId) return add({ setupId });
      if (
        status.state !== "blocked" &&
        !(
          status.stage === "prepare" &&
          status.state === "waiting" &&
          (status.reason === "developer-image-incompatible" ||
            status.reason === "developer-image-missing")
        )
      )
        return status;
      return show(
        status.stage === "add" ? "name" : status.stage === "prepare" ? "preparing" : "mac-checking",
      );
    },
    wifi: async ({ setupId, choice }) => {
      owned(setupId);
      wifiEnabled = choice === "wifi";
      return show(options.autoplay && choice === "wifi" ? "wifi-local-network" : "name");
    },
    add,
    complete: async ({ setupId, result }) => {
      owned(setupId);
      show("finishing");
      return push({ deviceId: result.deviceId, driverGeneration: result.generation });
    },
    failed: async ({ setupId, reason }) => {
      owned(setupId);
      return push({ state: "blocked", reason, action: "retry" });
    },
    wifiStatus: async () => ({ enabled: wifiEnabled, transport: "usb", reason: null }),
    configureWifi: async ({ action }) => {
      wifiEnabled = action !== "disable";
      return { enabled: wifiEnabled, transport: "usb", reason: null };
    },
    detach: async () => {
      throw new Error("The mock Mac detaches through the Host.");
    },
    completeDetach: async () => undefined,
    pendingDetaches: async () => [],
  };
  const orchestrated = createIphoneSetupPort(platform, async (command) => {
    if (command.type !== "iphone.screen.attach") throw new Error("Unexpected detach");
    if (options.dispatch) return options.dispatch(command);
    return IphoneScreenAttachResultSchema.parse({
      type: "iphone.screen.attach",
      deviceId:
        command.target.kind === "existing"
          ? command.target.deviceId
          : "dev_66666666-6666-4666-8666-666666666666",
      generation: 1,
    });
  });
  return {
    ...orchestrated,
    get current() {
      return current;
    },
    push,
    show,
    remove: async () => ({ pending: false }),
  };
}
