import { describe, expect, it, vi } from "vitest";
import type { PushRegistrationState } from "../notifications/push-registration.js";
import type { MachineSummary, OtherDevice } from "@opensteer/protocol";
import {
  accountSettingsModel,
  engineInstallationUpdateModel,
  notificationSettingsModel,
  otherDevicesSettingsRows,
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
    expect(notificationSettingsModel(state, false)?.action?.kind ?? null).toBe(action);
  });

  it("shows nothing about an Account or notifications in a build without an Account service", () => {
    expect(
      notificationSettingsModel({ preferences, status: "no-account-service" }, false),
    ).toBeNull();
    expect(
      accountSettingsModel(
        { available: false, detail: null, identity: null, status: "signed-out" },
        false,
      ),
    ).toBeNull();
  });

  it("says nothing more about notifications once they reach this phone", () => {
    expect(notificationSettingsModel({ preferences, status: "registered" }, false)).toMatchObject({
      action: null,
      detail: null,
      preferences,
    });
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

describe("other devices in settings", () => {
  const macMini = "rnr_11111111-1111-4111-8111-111111111111";

  it("sends a device to its setup task only while that task waits on the person", () => {
    const device = {
      computer: { id: macMini, name: "Mac mini", status: "online" },
      issue: null,
      kind: "tv",
      name: "Living room TV",
      pluginId: "living-room-tv",
      setupThreadId: "thr_setup",
    } as OtherDevice;
    expect(otherDevicesSettingsRows([device], new Set(["thr_setup"]))).toEqual([
      {
        detail: "Needs you",
        key: "living-room-tv",
        name: "Living room TV",
        opens: { kind: "task", threadId: "thr_setup" },
        symbol: "tv",
      },
    ]);
    expect(otherDevicesSettingsRows([device], new Set(["thr_other"]))[0]).toMatchObject({
      detail: "via Mac mini",
      opens: { kind: "plugin", pluginId: "living-room-tv" },
    });
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
        deploymentName: "Mac mini",
        machines: [macMini],
      }),
    ).toEqual({
      body: "Passwords are kept in the Opensteer app on Studio Mac. Set them up and manage them there.",
      detail: "Kept on Studio Mac",
      facts: [
        "You allow an account from any device signed in to this Opensteer. Your agents can then use it for your tasks.",
        "Cards work on websites only. Every use needs a fresh approval, lasting up to 30 minutes; it does not approve a charge.",
        "You can allow or decline a sign-in from this phone. Allowing first confirms it’s you on this device.",
        "In Opensteer’s browser, tap a sign-in field to fill your own saved login. Studio Mac types it; it never comes to this phone.",
        "When you sign in by hand there, Opensteer offers to save that login on Studio Mac. The password stays there.",
      ],
      title: "Passwords",
    });
    // Before the Mac reports itself, a Personal Opensteer is named after it.
    expect(
      passwordsSettingsModel({
        deploymentName: "Mac mini",
        machines: [],
      }).detail,
    ).toBe("Kept on Mac mini");
  });
});
