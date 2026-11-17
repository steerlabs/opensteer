import { describe, expect, it, vi } from "vitest";
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

describe("preview notification response identity", () => {
  it("opens both successive notifications grouped in one Thread", () => {
    const expo = expoNotifications();
    let opened!: Parameters<ExpoNotificationsLike["addNotificationResponseReceivedListener"]>[0];
    expo.notifications.addNotificationResponseReceivedListener = (listener) => {
      opened = listener;
      return { remove() {} };
    };
    const instance = createExpoNotificationPort({
      application: {
        ApplicationReleaseType: { APP_STORE: 5 },
        getIosPushNotificationServiceEnvironmentAsync: async () => "production",
        getIosApplicationReleaseTypeAsync: async () => 5,
      },
      androidPushConfigured: true,
      brandColor: "#e6beb0",
      channelName: "Opensteer",
      notifications: expo.notifications,
      platform: "android",
      registry: { register: async () => {}, unregister: async () => {} },
      signedInSubject: async () => "subject",
    });
    const destinations: string[] = [];
    instance.onOpened((destination) => {
      destinations.push(destination.deepLink);
    });
    const dep = "dep_00000000-0000-4000-8000-000000000001";
    const thread = "thr_00000000-0000-4000-8000-000000000003";
    for (const suffix of ["004", "005"]) {
      opened({
        actionIdentifier: expo.notifications.DEFAULT_ACTION_IDENTIFIER,
        notification: {
          request: {
            identifier: `${dep}:ntf_00000000-0000-4000-8000-000000000${suffix}`,
            content: {
              data: {
                deepLink: `com.opensteer.mobile:/deployments/${dep}/threads/${thread}?messageId=msg_00000000-0000-4000-8000-000000000${suffix}`,
              },
            },
          },
        },
      });
    }
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).not.toBe(destinations[1]);
  });
});

describe("notification response consumption", () => {
  function response(identifier: string, deepLink = "com.opensteer.mobile:/unrecognized") {
    return {
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      notification: { request: { identifier, content: { data: { deepLink } } } },
    };
  }

  function fixture() {
    const { expo, instance } = port({ androidPushConfigured: true, platform: "ios" });
    let retained: ReturnType<typeof response> | null = response("a");
    let emit!: Parameters<ExpoNotificationsLike["addNotificationResponseReceivedListener"]>[0];
    const order: string[] = [];
    expo.notifications.addNotificationResponseReceivedListener = (listener) => {
      order.push("subscribe");
      emit = listener;
      return { remove() {} };
    };
    expo.notifications.getLastNotificationResponse = () => {
      order.push("read");
      return retained;
    };
    const clear = vi.fn(() => {
      retained = null;
    });
    expo.notifications.clearLastNotificationResponse = clear;
    return {
      instance,
      order,
      clear,
      emit: (value: ReturnType<typeof response>) => {
        retained = value;
        emit(value);
      },
    };
  }

  it("subscribes before reading and acknowledges only after navigation, deduping older responses too", async () => {
    const f = fixture();
    const navigation = Promise.withResolvers<void>();
    const route = vi.fn(() => navigation.promise);
    f.instance.onOpened(route);
    f.emit(response("a"));
    expect(f.order.slice(0, 2)).toEqual(["subscribe", "read"]);
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]).toEqual([
      { identifier: "a", deepLink: "com.opensteer.mobile:/unrecognized" },
    ]);
    expect(f.clear).not.toHaveBeenCalled();
    navigation.resolve();
    await vi.waitFor(() => expect(f.clear).toHaveBeenCalledTimes(1));
    f.emit(response("b"));
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(2));
    f.emit(response("a"));
    expect(route).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed route available for another delivery", async () => {
    const f = fixture();
    const route = vi
      .fn()
      .mockRejectedValueOnce(new Error("navigation failed"))
      .mockResolvedValue(undefined);
    f.instance.onOpened(route);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    await route.mock.results[0]!.value.catch(() => undefined);
    expect(f.clear).not.toHaveBeenCalled();
    f.emit(response("a"));
    await vi.waitFor(() => expect(f.clear).toHaveBeenCalledTimes(1));
    expect(route).toHaveBeenCalledTimes(2);
  });

  it("never clears a newer retained response when an older route completes", async () => {
    const f = fixture();
    const a = Promise.withResolvers<void>();
    const b = Promise.withResolvers<void>();
    f.instance.onOpened(({ identifier }) => (identifier === "a" ? a.promise : b.promise));
    f.emit(response("b"));
    a.resolve();
    await a.promise;
    expect(f.clear).not.toHaveBeenCalled();
    b.resolve();
    await vi.waitFor(() => expect(f.clear).toHaveBeenCalledTimes(1));
  });
});
