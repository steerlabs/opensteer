import { NotificationPreviews } from "./notification-preview.js";
import { createId } from "@opensteer/core";
import { DeviceLimitReachedError, PushNotConfiguredError } from "@opensteer/client/connections";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import type { RegisterNotificationDeviceRequest } from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  PushRegistration,
  type NotificationDeviceRegistry,
  type PushPermissionState,
  type PushRegistrationOptions,
} from "./push-registration.js";

const filePath = "/private/notifications.json";
const firstToken = "a".repeat(64);
const secondToken = "b".repeat(64);
const subject = "acct_0192f4a1-0000-4000-8000-000000000001";

class FakeRegistry implements NotificationDeviceRegistry {
  readonly registrations: { installationId: string; request: RegisterNotificationDeviceRequest }[] =
    [];
  readonly removals: string[] = [];
  failure: Error | null = null;

  async register(
    installationId: string,
    request: RegisterNotificationDeviceRequest,
  ): Promise<unknown> {
    if (this.failure) throw this.failure;
    this.registrations.push({ installationId, request });
    return { device: { installationId } };
  }

  async unregister(installationId: string): Promise<unknown> {
    this.removals.push(installationId);
    return { installationId, unregistered: true };
  }
}

function open(
  overrides: Partial<PushRegistrationOptions> & {
    readonly permission?: PushPermissionState;
  } = {},
) {
  const privateFiles = new MemoryPrivateFilesystem();
  const registry = new FakeRegistry();
  const tokenListeners = new Set<(token: string) => void>();
  const state: {
    permission: PushPermissionState;
    requested: number;
    subject: string | null;
    token: string;
  } = {
    permission: overrides.permission ?? { canAskAgain: true, granted: true },
    requested: 0,
    subject,
    token: firstToken,
  };
  let seed = 1;
  const registration = new PushRegistration({
    accountConfigured: true,
    filePath,
    permissions: {
      current: async () => state.permission,
      request: async () => {
        state.requested += 1;
        state.permission = { canAskAgain: false, granted: true };
        return state.permission;
      },
    },
    platform: "ios",
    privateFiles,
    randomBytes: (size) => new Uint8Array(size).map(() => (seed = (seed * 31 + 7) % 251)),
    registry,
    signedInSubject: async () => state.subject,
    tokens: {
      current: async () => state.token,
      apsEnvironment: async () => "development",
      subscribe: (listener) => {
        tokenListeners.add(listener);
        return () => tokenListeners.delete(listener);
      },
    },
    ...overrides,
  });
  return {
    privateFiles,
    registration,
    registry,
    rollToken: (token: string) => {
      state.token = token;
      for (const listener of tokenListeners) listener(token);
    },
    state,
  };
}

describe("PushRegistration", () => {
  it("PUTs on every sync even for an unchanged registration", async () => {
    const { registration, registry } = open();

    await registration.start();
    await registration.sync();

    expect(registration.getSnapshot()).toEqual({
      preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
      status: "registered",
    });
    expect(registry.registrations).toHaveLength(2);
    expect(registry.registrations[0]?.request).toEqual({
      approvalsEnabled: true,
      apsEnvironment: "development",
      platform: "ios",
      runOutcomesEnabled: true,
      token: firstToken,
    });
  });

  it("keeps one installation id across launches and registrations", async () => {
    const { privateFiles, registration, registry, rollToken } = open();
    await registration.start();
    rollToken(secondToken);
    await registration.sync();

    const installationIds = new Set(registry.registrations.map((entry) => entry.installationId));

    expect(registry.registrations).toHaveLength(3);
    expect(installationIds.size).toBe(1);
    expect(privateFiles.text(filePath)).toContain([...installationIds][0]);
  });

  it("re-registers when the provider rolls the token", async () => {
    const { registration, registry, rollToken } = open();
    await registration.start();
    rollToken(secondToken);
    // The listener's own sync is queued; awaiting one more drains it.
    await registration.sync();

    expect(registry.registrations.map((entry) => entry.request.token)).toEqual([
      firstToken,
      secondToken,
      secondToken,
    ]);
  });

  it("re-registers when the person changes a preference, and remembers the choice", async () => {
    const { privateFiles, registration, registry } = open();
    await registration.start();

    await registration.setPreferences({ approvalsEnabled: true, runOutcomesEnabled: false });

    expect(registration.getSnapshot().preferences).toEqual({
      approvalsEnabled: true,
      runOutcomesEnabled: false,
    });
    expect(registry.registrations[1]?.request).toMatchObject({ runOutcomesEnabled: false });
    expect(JSON.parse(privateFiles.text(filePath) ?? "null")).toMatchObject({
      preferences: { approvalsEnabled: true, runOutcomesEnabled: false },
    });
  });

  it("re-registers when a different Account signs in", async () => {
    const { registration, registry, state } = open();
    await registration.start();

    state.subject = "acct_0192f4a1-0000-4000-8000-000000000002";
    await registration.sync();

    expect(registry.registrations).toHaveLength(2);
  });

  it("says who is missing before it asks the operating system anything", async () => {
    const { registration, registry, state } = open();
    state.subject = null;

    await registration.start();

    expect(registration.getSnapshot().status).toBe("signed-out");
    expect(registry.registrations).toHaveLength(0);
  });

  it("tells apart a permission nobody has asked for from one that was refused", async () => {
    const undetermined = open({ permission: { canAskAgain: true, granted: false } });
    await undetermined.registration.start();

    expect(undetermined.registration.getSnapshot().status).toBe("permission-undetermined");

    const denied = open({ permission: { canAskAgain: false, granted: false } });
    await denied.registration.start();

    expect(denied.registration.getSnapshot().status).toBe("permission-denied");
    expect(denied.registry.registrations).toHaveLength(0);
  });

  it("asks once after successful sends when permission is undetermined", async () => {
    const { registration, state, registry } = open({
      permission: { granted: false, canAskAgain: true },
    });
    await registration.start();
    expect(state.requested).toBe(0);
    await Promise.all([registration.afterSuccessfulSend(), registration.afterSuccessfulSend()]);
    expect(state.requested).toBe(1);
    expect(registry.registrations).toHaveLength(1);
  });

  it.each(["signed-out", "unconfigured", "denied", "granted"])(
    "does not prompt after send when %s",
    async (condition) => {
      const fixture = open({ accountConfigured: condition !== "unconfigured" });
      fixture.state.subject = condition === "signed-out" ? null : subject;
      fixture.state.permission = {
        granted: condition === "granted",
        canAskAgain: condition !== "denied",
      };
      await fixture.registration.afterSuccessfulSend();
      expect(fixture.state.requested).toBe(0);
    },
  );

  it("preserves the installation id from the previous registration file", async () => {
    const fixture = open();
    const installationId = "install-upgrade-0001";
    fixture.privateFiles.put(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
        registered: {
          accountSubject: subject,
          approvalsEnabled: true,
          platform: "ios",
          runOutcomesEnabled: true,
          token: firstToken,
        },
      }),
    );
    await fixture.registration.start();
    expect(fixture.registry.registrations[0]?.installationId).toBe(installationId);
  });

  it("shows a missing push entitlement as a registration failure", async () => {
    const fixture = open({
      tokens: {
        current: async () => firstToken,
        subscribe: () => () => undefined,
        apsEnvironment: async () => {
          throw new Error("This build has no push entitlement");
        },
      },
    });
    await fixture.registration.start();
    expect(fixture.registration.getSnapshot()).toMatchObject({
      status: "unavailable",
      detail: "This build has no push entitlement",
    });
    expect(fixture.registry.registrations).toEqual([]);
  });

  it("asks once and registers on the answer", async () => {
    const { registration, registry, state } = open({
      permission: { canAskAgain: true, granted: false },
    });
    await registration.start();

    await registration.requestPermission();

    expect(state.requested).toBe(1);
    expect(registration.getSnapshot().status).toBe("registered");
    expect(registry.registrations).toHaveLength(1);
  });

  it("names a service that holds no push credentials rather than calling it a failure", async () => {
    const { registration, registry } = open();
    registry.failure = new PushNotConfiguredError();

    await registration.start();

    expect(registration.getSnapshot()).toEqual({
      preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
      status: "push-not-configured",
    });
  });

  it("says the Account is full rather than retrying against a bound that will not move", async () => {
    const { registration, registry } = open();
    registry.failure = new DeviceLimitReachedError();

    await registration.start();

    expect(registration.getSnapshot()).toEqual({
      preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
      status: "device-limit",
    });

    // Somebody freed a slot on another phone; every sync sends, so asking
    // again registers.
    registry.failure = null;
    await registration.sync();

    expect(registration.getSnapshot().status).toBe("registered");
  });

  it("says what failed when the Account refuses, and retries on the next sync", async () => {
    const { registration, registry } = open();
    registry.failure = new Error("The Opensteer Account rejected the notification registration.");

    await registration.start();

    expect(registration.getSnapshot()).toEqual({
      detail: "The Opensteer Account rejected the notification registration.",
      preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
      status: "unavailable",
    });

    registry.failure = null;
    await registration.sync();

    expect(registration.getSnapshot().status).toBe("registered");
  });

  it("withdraws the registration before the Account credential is revoked", async () => {
    const { privateFiles, registration, registry, state } = open();
    await registration.start();
    const installationId = registry.registrations[0]?.installationId;

    await registration.signOut();

    expect(registry.removals).toEqual([installationId]);
    expect(JSON.parse(privateFiles.text(filePath) ?? "null")).toMatchObject({ registered: null });
    expect(registration.getSnapshot().status).toBe("signed-out");

    // Only after that does the credential go, and nothing puts the row back.
    state.subject = null;
    await registration.sync();

    expect(registration.getSnapshot().status).toBe("signed-out");
    expect(registry.registrations).toHaveLength(1);
  });

  it("starts over rather than failing when the remembered file is unreadable", async () => {
    const { privateFiles, registration, registry } = open();
    privateFiles.put(filePath, "{not json");

    await registration.start();

    expect(registration.getSnapshot().status).toBe("registered");
    expect(registry.registrations).toHaveLength(1);
  });

  it("serializes overlapping syncs and PUTs for each", async () => {
    const { registration, registry } = open();

    await Promise.all([registration.start(), registration.sync(), registration.sync()]);

    expect(registry.registrations).toHaveLength(3);
  });

  it("does not loop when reading the token announces it to the token listener", async () => {
    let reads = 0;
    const listeners = new Set<(token: string) => void>();
    const { registration, registry } = open({
      tokens: {
        apsEnvironment: async () => "development",
        current: async () => {
          reads += 1;
          // Expo's getDevicePushTokenAsync also emits to every push token
          // listener. The bound keeps a regression from spinning forever.
          if (reads < 10) for (const listener of listeners) listener(firstToken);
          return firstToken;
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });

    await registration.start();
    await registration.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reads).toBe(2);
    expect(registry.registrations).toHaveLength(2);
  });

  it("registers a token rotated while a read was returning the previous one", async () => {
    const listeners = new Set<(token: string) => void>();
    let finishRead: ((token: string) => void) | null = null;
    const { registration, registry } = open({
      tokens: {
        apsEnvironment: async () => "development",
        current: () =>
          new Promise<string>((resolve) => {
            finishRead = resolve;
          }),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });

    const started = registration.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const listener of listeners) listener(secondToken);
    finishRead!(firstToken);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registry.registrations.map((entry) => entry.request.token)).toEqual([
      firstToken,
      secondToken,
    ]);
  });

  it("withdraws the confirmed registration at sign-out after a later refusal", async () => {
    const { registration, registry } = open();
    await registration.start();
    registry.failure = new PushNotConfiguredError();
    await registration.sync();
    expect(registration.getSnapshot().status).toBe("push-not-configured");

    registry.failure = null;
    await registration.signOut();

    expect(registry.removals).toHaveLength(1);
    expect(registration.getSnapshot().status).toBe("signed-out");
  });

  it("stops watching the token when it is stopped", async () => {
    const { registration, registry, rollToken } = open();
    await registration.start();

    registration.stop();
    rollToken(secondToken);
    await Promise.resolve();

    expect(registry.registrations).toHaveLength(1);
  });
});

it("erases previews and settles sign-out when a concurrent push refresh is refused", async () => {
  let refuse = false;
  let release!: () => void;
  const refresh = new Promise<void>((resolve) => {
    release = resolve;
  });
  let previews!: NotificationPreviews;
  const f = open({
    signedInSubject: async () => {
      if (refuse) {
        await refresh;
        await previews.clear(null);
        return null;
      }
      return subject;
    },
  });
  const native = {
    notificationPreviewVersion: 1,
    prepare: vi.fn(async () => {}),
    key: vi.fn(async () => ({ keyId: "key", key: "key" })),
    erase: vi.fn(async () => {}),
  };
  previews = new NotificationPreviews(native, f.registration, async () => subject);
  await f.registration.start();
  refuse = true;
  const sync = f.registration.sync();
  previews.attach({
    deploymentId: createId("deployment"),
    capabilities: ["notification-preview-v1"],
    current: () => true,
    dispatch: vi.fn(async () => {}),
  });
  const reconcile = previews.reconcile();
  release();
  let settled = false;
  const done = Promise.all([sync, reconcile]).then(async () => {
    await f.registration.signOut();
    settled = true;
  });
  await vi.waitFor(
    () => {
      expect(native.erase, "refused refresh must erase native previews").toHaveBeenCalledWith(null);
      expect(settled, "push refresh and Account sign-out must settle").toBe(true);
    },
    { timeout: 1000 },
  );
  await done;
  f.registration.stop();
});
