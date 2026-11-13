import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { createPhoneSetupFile, type PhoneSetupProgress } from "./setup-file.js";
import { MockHostClient } from "@opensteer/client/mock";
import { deviceAccess } from "@opensteer/protocol";
import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { describe, expect, it, vi } from "vitest";
import type { IphoneAppsController, IphoneAppsState } from "../iphone-apps/controller.js";
import { createFakeIphoneApps } from "../iphone-apps/fake-bridge.js";
import { IphoneAppsController as Controller } from "../iphone-apps/controller.js";
import {
  PhoneSetup,
  phoneMembership,
  phoneSetupDraft,
  type PhoneSetupDraft,
} from "./phone-setup.js";

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";

/** The controller's two calls, recorded in order; the OS answers per app. */
function fakeController(options: {
  readonly add?: Awaited<ReturnType<IphoneAppsController["add"]>>;
  readonly denied?: readonly string[];
  readonly interrupted?: string;
  readonly persistence?: Controller;
}) {
  const calls: string[] = [];
  let state = {
    changes: {},
    failures: {},
    phoneSetups: {},
  } as unknown as IphoneAppsState;
  const controller = {
    add: async (input: Parameters<IphoneAppsController["add"]>[0]) => {
      calls.push(`add:${JSON.stringify(input.access ?? null)}`);
      return options.add ?? { kind: "added", runnerId: "rnr_phone" };
    },
    share: async (input: Parameters<IphoneAppsController["share"]>[0]) => {
      const app = input.apps[0]!.app;
      calls.push(`share:${app}`);
      if (options.interrupted === app) throw new Error("App closed during prompt");
      state = {
        ...state,
        failures: options.denied?.includes(app)
          ? { [app]: { kind: "blocked", permission: "denied" } }
          : {},
      } as IphoneAppsState;
    },
    savePhoneSetup: async (id: string, progress: PhoneSetupProgress | null) => {
      await options.persistence?.savePhoneSetup(id, progress);
    },
    getState: () => ({ ...state, phoneSetups: options.persistence?.getState().phoneSetups ?? {} }),
  } as unknown as IphoneAppsController;
  return { calls, controller };
}

function host(devices: boolean): HostClient {
  let access = {
    revision: 0,
    policy: {
      browser: true,
      apps: true,
      reach: "nobody",
      commands: false,
      forwarding: false,
      shares: [],
    },
  };
  return {
    getSnapshot: () => ({
      devicesAvailable: devices,
      iphoneAppsAvailable: true,
      machines: [{ id: "rnr_phone", access }],
    }),
    refresh: async () => undefined,
    updateMachineAccess: async (input: Parameters<HostClient["updateMachineAccess"]>[0]) => {
      access = { revision: access.revision + 1, policy: input.policy } as typeof access;
      return { outcome: "updated", revision: access.revision };
    },
  } as unknown as HostClient;
}

const draft: PhoneSetupDraft = {
  name: " Alex's iPhone ",
  browser: true,
  apps: { "apple-calendar": true, "iphone-location": true, "iphone-photos": false },
  notifications: true,
};

describe("Set up this phone", () => {
  it("enrolls with the switches, then asks one prompt at a time, Notifications first", async () => {
    const { calls, controller } = fakeController({ denied: ["iphone-location"] });
    const setup = new PhoneSetup(draft);
    const asked: string[] = [];
    setup.subscribe(() => {
      const phase = setup.getState().phase;
      if (phase.kind === "asking" && asked.at(-1) !== phase.item) asked.push(phase.item);
    });
    const notifications = {
      choose: async (on: boolean) => {
        calls.push(`notifications:${on}`);
        return "denied" as const;
      },
    };
    const state = await setup.run({
      controller,
      deploymentId,
      draft,
      hostClient: host(true),
      notifications,
    });
    expect(calls).toEqual([
      'add:{"browser":true,"apps":true,"files":false}',
      "notifications:true",
      "share:apple-calendar",
      "share:iphone-location",
    ]);
    expect(asked).toEqual(["notifications", "apple-calendar", "iphone-location"]);
    // Refusals read honestly and never hold up Ready.
    expect(state).toEqual({
      phase: { kind: "ready", runnerId: "rnr_phone" },
      browser: "on",
      notifications: "denied",
      apps: { "apple-calendar": "on", "iphone-location": "denied", "iphone-photos": "off" },
    });
  });

  it("applies Notifications Off without a prompt, and reads back how it settled", async () => {
    const { controller } = fakeController({});
    const off = { ...draft, apps: {}, notifications: false };
    const setup = new PhoneSetup(off);
    const asked: string[] = [];
    setup.subscribe(() => {
      const phase = setup.getState().phase;
      if (phase.kind === "asking") asked.push(phase.item);
    });
    const chosen: boolean[] = [];
    const state = await setup.run({
      controller,
      deploymentId,
      draft: off,
      hostClient: host(true),
      notifications: {
        choose: async (on) => {
          chosen.push(on);
          return "off";
        },
      },
    });
    expect(chosen).toEqual([false]);
    expect(asked).toEqual([]);
    expect(state.notifications).toBe("off");
  });

  it("sends no switches to a Host without devices-v1, and asks nothing when enrollment fails", async () => {
    const { calls, controller } = fakeController({
      add: { failure: { kind: "remote-access-off" }, kind: "failed" },
    });
    const state = await new PhoneSetup(draft).run({
      controller,
      deploymentId,
      draft,
      hostClient: host(false),
      notifications: { choose: async () => "on" },
    });
    expect(calls).toEqual(["add:null"]);
    expect(state.phase).toEqual({ kind: "failed", failure: { kind: "remote-access-off" } });
  });

  it.each(["late", "pending"] as const)(
    "applies revised Browser Off after a %s enrollment, using the Host's current revision",
    async (completion) => {
      const host = new MockHostClient({ latencyMs: 0 });
      const fake = createFakeIphoneApps({ autoConnect: false });
      const controller = new Controller({
        bridge: fake.bridge,
        shownApprovals: { read: async () => [], write: async () => undefined },
        timing: { enrollWaitMs: 50 },
      });
      try {
        const target = unwrapRpcResult(await host.rpc["agentPhone.target.get"]({}));
        const deploymentId = target.deploymentId;
        const first = await controller.add({
          deploymentId,
          hostClient: host,
          iphoneAppsAvailable: true,
          name: draft.name,
          access: { browser: true, apps: true, files: false },
        });
        expect(first.kind).toBe("failed");
        host.mockConnectIphone({
          enrollmentId: fake.bridge.getSnapshot().enrollment!.enrollmentId!,
          runnerId: fake.device.runnerId(),
          name: draft.name,
        });
        if (completion === "late") fake.device.connect();
        const update = host.updateMachineAccess.bind(host);
        let conflicted = false;
        host.updateMachineAccess = async (input) => {
          if (!conflicted) {
            conflicted = true;
            await update({ ...input, policy: { ...input.policy, browser: true } });
            return { outcome: "conflict" };
          }
          return update(input);
        };
        const running = new PhoneSetup(draft).run({
          controller,
          deploymentId,
          draft: { ...draft, browser: false, apps: {} },
          hostClient: host,
          notifications: { choose: async () => "on" },
        });
        if (completion === "pending") {
          await vi.waitFor(() => expect(controller.getState().adding).toBe(deploymentId), {
            timeout: 1_000,
          });
          fake.device.connect();
        }
        const state = await running;
        const machine = host.getSnapshot().machines.find(({ id }) => id === fake.device.runnerId());
        expect(deviceAccess(machine!.access!.policy)).toEqual({
          browser: false,
          apps: false,
          files: false,
        });
        expect(state.browser).toBe("off");
        expect(state.phase.kind).toBe("ready");
        expect(conflicted).toBe(true);
      } finally {
        controller.dispose();
        host.dispose();
      }
    },
  );

  it("durably resumes the unfinished prompt after restart without repeating completed steps", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const filePath = "/private/phone-setup.json";
    const setupFile = createPhoneSetupFile({ privateFiles, filePath });
    const open = () =>
      new Controller({
        bridge: createFakeIphoneApps().bridge,
        setupFile,
        shownApprovals: { read: async () => [], write: async () => undefined },
      });
    const persistence = open();
    await persistence.load();
    const first = fakeController({ persistence, interrupted: "iphone-location" });
    const notifications = { choose: vi.fn(async () => "on" as const) };
    await expect(
      new PhoneSetup(draft).run({
        controller: first.controller,
        deploymentId,
        draft,
        hostClient: host(false),
        notifications,
      }),
    ).rejects.toThrow("App closed");
    const stored = await createPhoneSetupFile({ privateFiles, filePath }).read();
    expect(stored[deploymentId]?.draft).toEqual(draft);
    expect(stored[deploymentId]?.completed).toEqual([
      "enrollment",
      "notifications",
      "apple-calendar",
    ]);
    persistence.dispose();
    const reloaded = open();
    await reloaded.load();
    const restarted = fakeController({ persistence: reloaded });
    const membershipState = {
      ...restarted.controller.getState(),
      adding: null,
      removedFrom: null,
      snapshot: { supported: true, enrollment: { deploymentId, state: "enrolled" } },
    } as unknown as IphoneAppsState;
    expect(
      phoneMembership({
        deploymentId,
        host: { iphoneAppsAvailable: true },
        iphone: membershipState,
      }).state,
    ).toBe("finish-setup");
    const deferred = { ...stored[deploymentId]!, deferred: true };
    await reloaded.savePhoneSetup(deploymentId, deferred);
    const deferredOnDisk = await setupFile.read();
    expect(
      phoneMembership({
        deploymentId,
        host: { iphoneAppsAvailable: true },
        iphone: { ...membershipState, phoneSetups: deferredOnDisk },
      }).state,
    ).toBe("ready");
    expect(
      phoneMembership({
        deploymentId: "another-deployment",
        host: { iphoneAppsAvailable: true },
        iphone: { ...membershipState, snapshot: { ...membershipState.snapshot, enrollment: null } },
      }).state,
    ).toBe("needs-setup");
    const state = await new PhoneSetup(stored[deploymentId]!.draft).run({
      controller: restarted.controller,
      deploymentId,
      draft: stored[deploymentId]!.draft,
      hostClient: host(false),
      notifications,
    });
    expect(state.phase.kind).toBe("ready");
    expect(notifications.choose).toHaveBeenCalledOnce();
    expect(restarted.calls.filter((call) => call.startsWith("share:"))).toEqual([
      "share:iphone-location",
    ]);
    expect(await setupFile.read()).toEqual({});
    reloaded.dispose();
  });

  it("asks nothing and keeps setup unfinished if the draft cannot be saved", async () => {
    const persistence = new Controller({
      bridge: createFakeIphoneApps().bridge,
      setupFile: {
        read: async () => ({}),
        write: async () => {
          throw new Error("disk unavailable");
        },
      },
      shownApprovals: { read: async () => [], write: async () => undefined },
    });
    await persistence.load();
    try {
      const { controller, calls } = fakeController({ persistence });
      const notifications = { choose: vi.fn(async () => "on" as const) };
      const setup = new PhoneSetup(draft);
      await expect(
        setup.run({ controller, deploymentId, draft, hostClient: host(false), notifications }),
      ).rejects.toThrow("disk unavailable");
      expect(calls).toEqual([]);
      expect(notifications.choose).not.toHaveBeenCalled();
      expect(setup.getState().phase.kind).toBe("failed");
    } finally {
      persistence.dispose();
    }
  });

  it("starts with Photos off and every other offered app on", () => {
    const fake = createFakeIphoneApps({ deviceName: "Alex's iPhone" });
    const controller = new Controller({
      bridge: fake.bridge,
      shownApprovals: { read: async () => [], write: async () => undefined },
    });
    expect(phoneSetupDraft(controller, "ios")).toEqual({
      name: "Alex's iPhone",
      browser: true,
      notifications: true,
      apps: {
        "apple-calendar": true,
        "apple-contacts": true,
        "apple-reminders": true,
        "iphone-location": true,
        "iphone-photos": false,
      },
    });
    expect(phoneSetupDraft(controller, "android").apps).toEqual({});
    controller.dispose();
  });
});

describe("whether this phone needs setting up here", () => {
  const state = (
    patch: Partial<IphoneAppsState["snapshot"]>,
    extra: Partial<IphoneAppsState> = {},
  ) =>
    ({
      adding: null,
      removedFrom: null,
      ...extra,
      snapshot: { enrollment: null, pendingErasure: false, supported: true, ...patch },
    }) as unknown as IphoneAppsState;
  const enrolled = (id: string) => ({
    deploymentId: id,
    deploymentName: "Home",
    enrollmentId: null,
    hostUrl: "https://home.example",
    name: "Alex's iPhone",
    runnerId: "rnr_0192f4a1-1111-4111-8111-111111111111",
    state: "enrolled" as const,
  });
  const host = { iphoneAppsAvailable: true };

  it("resumes pending and expired enrollment instead of claiming ready", () => {
    for (const issue of [null, "enrollment-expired"] as const) {
      const membership = phoneMembership({
        deploymentId,
        host,
        iphone: state({
          enrollment: { ...enrolled(deploymentId), state: "pending", enrollmentId: "ren_pending" },
          issue,
        }),
      });
      expect(membership).toEqual({ state: "finish-setup", reason: "Finish setting up this phone" });
    }
  });

  it("is due only on a Host that can take it, with no other Opensteer and no removal", () => {
    expect(phoneMembership({ deploymentId, host, iphone: state({}) }).state).toBe("needs-setup");
    expect(
      phoneMembership({ deploymentId, host: { iphoneAppsAvailable: false }, iphone: state({}) })
        .state,
    ).toBe("not-applicable");
    expect(
      phoneMembership({ deploymentId, host, iphone: state({ enrollment: enrolled(deploymentId) }) })
        .state,
    ).toBe("ready");
    expect(
      phoneMembership({ deploymentId, host, iphone: state({ enrollment: enrolled("dep_other") }) }),
    ).toEqual({ state: "elsewhere", deploymentName: "Home" });
    expect(
      phoneMembership({
        deploymentId,
        host,
        iphone: state({}, { removedFrom: { deploymentId, deploymentName: "Home" } }),
      }).state,
    ).toBe("removed");
    expect(
      phoneMembership({ deploymentId, host, iphone: state({}, { adding: deploymentId }) }).state,
    ).toBe("setting-up");
  });
});
