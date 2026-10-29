import { describe, expect, it } from "vitest";
import {
  createExpoNotificationPort,
  type ExpoNotificationsLike,
  type ExpoApplicationLike,
} from "./notification-port.js";

/** `expo-notifications` reduced to what this port touches, plus what it recorded. */
function expoNotifications() {
  const channels: { channel: unknown; id: string }[] = [];
  let tokenRequests = 0;
  const notifications: ExpoNotificationsLike = {
    AndroidImportance: { DEFAULT: 5 },
    DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
    addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
    addPushTokenListener: () => ({ remove: () => undefined }),
    clearLastNotificationResponse: () => undefined,
    dismissNotificationAsync: async () => undefined,
    getDevicePushTokenAsync: async () => {
      tokenRequests += 1;
      return { data: "f".repeat(64), type: "android" };
    },
    getLastNotificationResponse: () => null,
    getPermissionsAsync: async () => ({ canAskAgain: false, granted: true }),
    getPresentedNotificationsAsync: async () => [],
    requestPermissionsAsync: async () => ({ canAskAgain: false, granted: true }),
    setNotificationChannelAsync: async (id, channel) => {
      channels.push({ channel, id });
      return null;
    },
    setNotificationHandler: () => undefined,
  };
  return { channels, notifications, tokenRequests: () => tokenRequests };
}

function port(overrides: {
  readonly androidPushConfigured: boolean;
  readonly platform: "android" | "ios";
  readonly application?: ExpoApplicationLike;
}) {
  const expo = expoNotifications();
  return {
    expo,
    instance: createExpoNotificationPort({
      application: overrides.application ?? {
        ApplicationReleaseType: { APP_STORE: 5 },
        getIosPushNotificationServiceEnvironmentAsync: async () => "development",
        getIosApplicationReleaseTypeAsync: async () => 1,
      },
      androidPushConfigured: overrides.androidPushConfigured,
      brandColor: "#e6beb0",
      channelName: "Opensteer",
      notifications: expo.notifications,
      platform: overrides.platform,
      registry: { register: async (_id, request) => request, unregister: async () => undefined },
      signedInSubject: async () => null,
    }),
  };
}

describe("the Android notification channel", () => {
  it("is defined once, at ordinary importance and in the brand colour", async () => {
    const { expo, instance } = port({ androidPushConfigured: true, platform: "android" });

    await instance.prepare();

    expect(expo.channels).toEqual([
      { channel: { importance: 5, lightColor: "#e6beb0", name: "Opensteer" }, id: "default" },
    ]);
  });

  it("is not something iOS has", async () => {
    const { expo, instance } = port({ androidPushConfigured: true, platform: "ios" });

    await instance.prepare();

    expect(expo.channels).toEqual([]);
  });
});

describe("the Android push token", () => {
  it("says the build has no credentials rather than asking for a token it cannot mint", async () => {
    const { expo, instance } = port({ androidPushConfigured: false, platform: "android" });

    await expect(instance.tokens.current()).rejects.toThrow(
      "This build was made without Android push credentials.",
    );
    expect(expo.tokenRequests()).toBe(0);
  });

  it("is asked for when the build was given Firebase configuration", async () => {
    const { instance } = port({ androidPushConfigured: true, platform: "android" });

    expect(await instance.tokens.current()).toBe("f".repeat(64));
  });

  it("does not depend on Firebase configuration on iOS", async () => {
    const { instance } = port({ androidPushConfigured: false, platform: "ios" });

    expect(await instance.tokens.current()).toBe("f".repeat(64));
  });
});

describe("the iOS push entitlement", () => {
  it.each(["development", "production"] as const)(
    "uses the signed %s environment",
    async (environment) => {
      const { instance } = port({
        platform: "ios",
        androidPushConfigured: false,
        application: {
          ApplicationReleaseType: { APP_STORE: 5 },
          getIosPushNotificationServiceEnvironmentAsync: async () => environment,
          getIosApplicationReleaseTypeAsync: async () => {
            throw new Error("must not guess");
          },
        },
      });
      await expect(instance.tokens.apsEnvironment()).resolves.toBe(environment);
    },
  );
  it.each([0, 1, 2, 3, 4, 5])(
    "only infers production from APP_STORE when environment is null (release %i)",
    async (releaseType) => {
      const { instance } = port({
        platform: "ios",
        androidPushConfigured: false,
        application: {
          ApplicationReleaseType: { APP_STORE: 5 },
          getIosPushNotificationServiceEnvironmentAsync: async () => null,
          getIosApplicationReleaseTypeAsync: async () => releaseType,
        },
      });
      if (releaseType === 5)
        await expect(instance.tokens.apsEnvironment()).resolves.toBe("production");
      else
        await expect(instance.tokens.apsEnvironment()).rejects.toThrow(
          "This build has no push entitlement",
        );
    },
  );
});
