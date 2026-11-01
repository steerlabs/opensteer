import { describe, expect, it, vi } from "vitest";
import type { PushRegistrationState } from "../notifications/push-registration.js";
import type { MachineSummary } from "@opensteer/protocol";
import {
  computersSettingsFooter,
  computersSettingsFooterFor,
  computersSettingsRows,
  engineInstallationUpdateModel,
  notificationSettingsModel,
  passwordsSettingsModel,
  signOutAccountInOrder,
} from "./settings-model.js";

const preferences = { approvalsEnabled: true, runOutcomesEnabled: false };

describe("settings presentation", () => {
  it.each([
    ["available", "Update available · 2.0.0", true, false],
    ["current", "Up to date", false, false],
    ["manual", "Update on its computer.", false, false],
    ["unknown", "Update status unavailable.", true, false],
    ["updating", "Updating…", false, true],
    ["succeeded", "Updated", false, false],
    ["failed", "Update failed.", true, false],
  ] as const)(
    "renders the %s engine installation state",
    (update, detail, updateEnabled, updating) => {
      expect(
        engineInstallationUpdateModel(
          { latestVersion: "2.0.0", scope: "all", update, version: "1.0.0" },
          false,
        ),
      ).toEqual({ detail, updateEnabled, updating });
    },
  );

  it("keeps a locally initiated update pending until shared state catches up", () => {
    expect(
      engineInstallationUpdateModel(
        {
          latestVersion: "2.0.0",
          scope: "all",
          update: "available",
          version: "1.0.0",
        },
        true,
      ),
    ).toEqual({ detail: "Updating…", updateEnabled: false, updating: true });
  });

  it.each([
    ["no-account-service", null],
    ["signed-out", null],
    ["permission-undetermined", "request-permission"],
    ["permission-denied", "open-settings"],
    ["push-not-configured", null],
    ["device-limit", "retry-notifications"],
    ["registered", null],
    ["unavailable", "retry-notifications"],
  ] as const)("maps %s to its actionable repair", (status, action) => {
    const state: PushRegistrationState =
      status === "unavailable"
        ? { detail: "The Account did not answer.", preferences, status }
        : { preferences, status };
    expect(notificationSettingsModel(state, false).action?.kind ?? null).toBe(action);
  });
});

describe("Account sign-out", () => {
  it("withdraws notifications before revoking the Account credential", async () => {
    const order: string[] = [];
    const notifications = vi.fn(async () => {
      order.push("notifications");
    });
    const accountCredential = vi.fn(async () => {
      order.push("account");
    });

    await signOutAccountInOrder(notifications, accountCredential);

    expect(order).toEqual(["notifications", "account"]);
  });

  it("keeps the credential when notification revocation fails so retry remains possible", async () => {
    const accountCredential = vi.fn(async () => undefined);
    await expect(
      signOutAccountInOrder(async () => {
        throw new Error("offline");
      }, accountCredential),
    ).rejects.toThrow("offline");
    expect(accountCredential).not.toHaveBeenCalled();
  });
});

describe("computers in settings", () => {
  const macMini = "rnr_11111111-1111-4111-8111-111111111111";
  const machine = (overrides: Partial<MachineSummary>) =>
    ({
      access: null,
      allowedModules: ["integrations", "shell"],
      apps: null,
      computerUse: null,
      device: null,
      expiresAt: null,
      id: "rnr_2",
      lastSeenAt: null,
      modules: {},
      name: "Laptop",
      ownerName: null,
      ownership: "mine",
      status: "online",
      ...overrides,
    }) as MachineSummary;
  const personal = {
    apps: { connections: [], definitions: [] },
    cloud: false,
    deploymentKind: "personal" as const,
    deploymentName: "Mac mini",
    hostConnected: true,
    publicOrigin: null,
  };

  it("puts the Mac a Personal Opensteer runs on first, then each computer in the page's words", () => {
    expect(
      computersSettingsRows({
        ...personal,
        machines: [
          machine({ device: { form: "laptop", platform: "macos" } }),
          machine({
            allowedModules: ["agents", "browser", "shell"],
            device: { form: "compact", platform: "macos" },
            id: macMini,
            modules: { agents: { checkedAt: null, detail: null, readiness: "ready" } },
            name: "Mac mini",
            ownership: "deployment",
          }),
        ],
      }),
    ).toEqual([
      {
        detail: "Your Opensteer runs here · Online",
        key: "home",
        opens: { kind: "computer", machineId: macMini },
        name: "Mac mini",
        symbol: "macmini",
      },
      {
        detail: "Nothing shared yet · Online",
        key: "rnr_2",
        opens: { kind: "computer", machineId: "rnr_2" },
        name: "Laptop",
        symbol: "laptopcomputer",
      },
    ]);
  });
});

/*
 * The "You're here" row for this iPhone could mislead:
 * - it shows on a phone that cannot share its apps, or offers Add on an
 *   Opensteer that cannot take an iPhone;
 * - an added iPhone is listed twice, once as itself and once as a computer,
 *   or its own enrollment shows as a code that expires;
 * - an iPhone added to another Opensteer offers Add here, or opens a computer
 *   of the wrong Opensteer;
 * - a removal by the Host reads as never added;
 * - the footer never says this iPhone can be added.
 */
describe("this iPhone in settings", () => {
  const selected = "dep_0192f4a1-1111-4000-8000-000000000001";
  const other = "dep_0192f4a1-4444-4000-8000-000000000004";
  const runnerId = "rnr_77777777-7777-4777-8777-777777777777";
  const server = {
    apps: { connections: [], definitions: [] },
    cloud: false,
    deploymentKind: "server" as const,
    deploymentName: "Studio",
    hostConnected: true,
    publicOrigin: "https://studio.example.test",
  };
  const here = (
    overrides: Partial<NonNullable<Parameters<typeof computersSettingsRows>[0]["here"]>> = {},
  ) => ({
    approvals: 0,
    available: true,
    deploymentName: "Studio",
    deviceName: "Alex's iPhone",
    heldBy: null,
    removed: false,
    selectedDeploymentId: selected,
    ...overrides,
  });
  const iphoneMachine = {
    access: null,
    allowedModules: ["integrations"],
    apps: null,
    computerUse: null,
    device: { form: "phone", platform: "ios" },
    expiresAt: null,
    id: runnerId,
    lastSeenAt: null,
    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: "Work iPhone",
    ownerName: null,
    ownership: "mine",
    status: "online",
  } as unknown as MachineSummary;

  it("offers to add this iPhone right after where Opensteer runs, and says so below", () => {
    const rows = computersSettingsRows({ ...server, here: here(), machines: [] });
    expect(rows.map(({ key }) => key)).toEqual(["home", "this-iphone"]);
    expect(rows[1]).toEqual({
      detail: "You're here · Not added",
      key: "this-iphone",
      name: "Alex's iPhone",
      opens: { kind: "add-iphone" },
      symbol: "smartphone",
    });
    expect(computersSettingsFooterFor(rows)).toBe(
      "Add this iPhone to let agents use its Calendar, Contacts and Reminders while Opensteer is open. To add a computer, open Opensteer on it and choose Add on its Computers page. To add an Android phone, plug it into a computer and choose Add a phone there.",
    );
  });

  it("says to update an Opensteer that cannot take an iPhone, with nothing to tap", () => {
    const rows = computersSettingsRows({
      ...server,
      here: here({ available: false }),
      machines: [],
    });
    expect(rows[1]).toMatchObject({
      detail: "You're here · Update Opensteer on Studio to add this iPhone",
      opens: null,
    });
    expect(computersSettingsFooterFor(rows)).toBe(computersSettingsFooter);
  });

  it("lists an added iPhone once, as itself, with what waits for the person", () => {
    const heldBy = {
      deploymentId: selected,
      deploymentName: "Studio",
      enrollmentId: null,
      name: "Work iPhone",
      runnerId,
      state: "enrolled" as const,
    };
    const rows = computersSettingsRows({
      ...server,
      here: here({ heldBy }),
      machines: [iphoneMachine],
    });
    expect(rows.map(({ key }) => key)).toEqual(["home", runnerId]);
    expect(rows[1]).toEqual({
      detail: "You're here · Nothing shared yet · Online",
      key: runnerId,
      name: "Work iPhone",
      opens: { kind: "computer", machineId: runnerId },
      symbol: "smartphone",
    });
    const waiting = computersSettingsRows({
      ...server,
      here: here({ approvals: 2, heldBy }),
      machines: [iphoneMachine],
    });
    expect(waiting[1]?.detail).toBe("You're here · 2 waiting for you");
    expect(computersSettingsFooterFor(waiting)).toBe(computersSettingsFooter);
  });

  it("hides this iPhone's own pending enrollment while it is being added", () => {
    const pending = { ...iphoneMachine, id: "ren_pending", status: "pending" } as MachineSummary;
    const heldBy = {
      deploymentId: selected,
      deploymentName: "Studio",
      enrollmentId: "ren_pending",
      name: "Work iPhone",
      runnerId,
      state: "pending" as const,
    };
    const rows = computersSettingsRows({ ...server, here: here({ heldBy }), machines: [pending] });
    expect(rows.map(({ key }) => key)).toEqual(["home", "this-iphone"]);
    expect(rows[1]).toMatchObject({
      detail: "You're here · Not added",
      opens: { kind: "add-iphone" },
    });
  });

  it("names the Opensteer another iPhone is added to, and opens it there", () => {
    const heldBy = {
      deploymentId: other,
      deploymentName: "Home Mac",
      enrollmentId: null,
      name: "Work iPhone",
      runnerId,
      state: "enrolled" as const,
    };
    const rows = computersSettingsRows({ ...server, here: here({ heldBy }), machines: [] });
    expect(rows[1]).toEqual({
      detail: "You're here · Added to Home Mac",
      key: "this-iphone",
      name: "Work iPhone",
      opens: { deploymentId: other, kind: "computer", machineId: runnerId },
      symbol: "smartphone",
    });
  });

  it("says the Host removed it until it is added again", () => {
    const rows = computersSettingsRows({ ...server, here: here({ removed: true }), machines: [] });
    expect(rows[1]?.detail).toBe("You're here · Removed from Opensteer on Studio");
  });

  it("opens the pending enrollment on another Deployment without claiming it is added", () => {
    const heldBy = {
      deploymentId: other,
      deploymentName: "Home Mac",
      enrollmentId: "ren_pending",
      name: "Work iPhone",
      runnerId,
      state: "pending" as const,
    };
    const rows = computersSettingsRows({ ...server, here: here({ heldBy }), machines: [] });
    expect(rows[1]).toEqual({
      detail: "You're here · Being added to Home Mac",
      key: "this-iphone",
      name: "Work iPhone",
      opens: { deploymentId: other, kind: "computer", machineId: "ren_pending" },
      symbol: "smartphone",
    });
  });

  it("shows no row on a phone that cannot share its apps", () => {
    const rows = computersSettingsRows({ ...server, here: null, machines: [iphoneMachine] });
    expect(rows.map(({ key }) => key)).toEqual(["home", runnerId]);
  });
});

/*
 * How the phone's Passwords row could mislead:
 * - it offers to set up or manage passwords, which happens only on the Mac;
 * - it names "this Mac", or no Mac, on a Personal Opensteer whose Mac it knows;
 * - it names the Deployment's address as if a server kept passwords;
 * - before the Mac has reported itself, it says nothing useful.
 */
describe("Passwords in settings", () => {
  const macMini = {
    allowedModules: ["agents", "browser", "shell"],
    id: "rnr_11111111-1111-4111-8111-111111111111",
    name: "Studio Mac",
    ownership: "deployment",
  } as MachineSummary;

  it("names the Mac a Personal Opensteer keeps them on", () => {
    expect(
      passwordsSettingsModel({
        deploymentKind: "personal",
        deploymentName: "Mac mini",
        machines: [macMini],
      }),
    ).toEqual({
      body: "Passwords are kept in the Opensteer app on Studio Mac. Set them up and manage them there.",
      detail: "Kept on Studio Mac",
      facts: [
        "You allow an account once per Workspace, on Studio Mac, with Touch ID or your Mac password. After that, agents there sign in with it on their own.",
        "You can say no to a sign-in from this phone.",
      ],
      title: "Passwords",
    });
    // Before the Mac reports itself, a Personal Opensteer is named after it.
    expect(
      passwordsSettingsModel({
        deploymentKind: "personal",
        deploymentName: "Mac mini",
        machines: [],
      }).detail,
    ).toBe("Kept on Mac mini");
  });

  it("says a server Opensteer has none yet", () => {
    expect(
      passwordsSettingsModel({
        deploymentKind: "server",
        deploymentName: "steer.example.com",
        machines: [macMini],
      }),
    ).toEqual({
      body: "Saved-password sign-ins are available on a Personal Opensteer for now.",
      detail: "Not available on this Opensteer",
      facts: [],
      title: "Passwords",
    });
  });
});
