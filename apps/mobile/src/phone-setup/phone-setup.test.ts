import type { HostClient } from "@opensteer/client/host";
import { describe, expect, it } from "vitest";
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
}) {
  const calls: string[] = [];
  let state = { changes: {}, failures: {} } as unknown as IphoneAppsState;
  const controller = {
    add: async (input: Parameters<IphoneAppsController["add"]>[0]) => {
      calls.push(`add:${JSON.stringify(input.access ?? null)}`);
      return options.add ?? { kind: "added", runnerId: "rnr_phone" };
    },
    share: async (input: Parameters<IphoneAppsController["share"]>[0]) => {
      const app = input.apps[0]!.app;
      calls.push(`share:${app}`);
      state = {
        ...state,
        failures: options.denied?.includes(app)
          ? { [app]: { kind: "blocked", permission: "denied" } }
          : {},
      } as IphoneAppsState;
    },
    getState: () => state,
  } as unknown as IphoneAppsController;
  return { calls, controller };
}

function host(devices: boolean): HostClient {
  return {
    getSnapshot: () => ({ devicesAvailable: devices, iphoneAppsAvailable: true }),
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
