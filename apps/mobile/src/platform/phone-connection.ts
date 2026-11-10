import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { HostClient } from "@opensteer/client/host";
import { hostApiVersion } from "@opensteer/deployment-authority";
import type {
  PhoneBrowserNativeEvent,
  PhoneBrowserNativePort,
} from "../phone-browser/native-port.js";
import type { IphoneAppsBridge, IphoneAppsSnapshot } from "./iphone-apps.js";
import { phoneEnrollmentHost } from "./phone-enrollment-host.js";

export type PhoneConnectionPort = Pick<
  PhoneBrowserNativePort,
  | "initialize"
  | "fence"
  | "setForeground"
  | "onEvent"
  | "verifyAttach"
  | "commitAttach"
  | "sendRelay"
  | "closeChannel"
>;

interface NativePhoneConnection extends Omit<PhoneConnectionPort, "onEvent"> {
  now(): number;
  getSnapshot(): IphoneAppsSnapshot;
  prepare: IphoneAppsBridge["prepare"];
  discardPendingEnrollment: IphoneAppsBridge["discardPendingEnrollment"];
  retarget: IphoneAppsBridge["retarget"];
  disconnect: IphoneAppsBridge["disconnect"];
  enrollFromHost(input: {
    readonly apiVersion: number;
    readonly origin: string;
    readonly authorization: string;
    readonly deploymentId: string;
    readonly name: string;
  }): Promise<{ readonly enrollmentId: string }>;
  completeRetirement(): Promise<void>;
  addListener(
    event: "onChange",
    listener: (snapshot: IphoneAppsSnapshot) => void,
  ): { remove(): void };
  addListener(
    event: "onEvent",
    listener: (event: PhoneBrowserNativeEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onRetire",
    listener: (event: { readonly deploymentId: string }) => void,
  ): { remove(): void };
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativePhoneConnection>("PhoneConnection")
    : null;

function connection(): NativePhoneConnection {
  if (native === null) throw new Error("This build cannot connect this phone's browser.");
  return native;
}

export const phoneConnection: PhoneConnectionPort = {
  initialize: (input) => connection().initialize(input),
  fence: (reason) => connection().fence(reason),
  setForeground: (input) => connection().setForeground(input),
  verifyAttach: (input) => connection().verifyAttach(input),
  commitAttach: (input) => connection().commitAttach(input),
  sendRelay: (input) => connection().sendRelay(input),
  closeChannel: (input) => connection().closeChannel(input),
  onEvent: (listener) => {
    let subscribed = true;
    const subscription = connection().addListener("onEvent", (event) => {
      if (subscribed) void listener(event).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      subscription.remove();
    };
  },
};

export async function retryPhoneRetirement(): Promise<void> {
  if (connection().getSnapshot().pendingErasure) await connection().completeRetirement();
}

export const phoneConnectionClock = {
  now: () => connection().now(),
  schedule: (callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

let retirementHandler: ((deploymentId: string) => Promise<unknown>) | null = null;

native?.addListener("onRetire", ({ deploymentId }) => {
  void Promise.resolve()
    .then(async () => {
      try {
        await retirementHandler?.(deploymentId);
      } finally {
        await connection().completeRetirement();
      }
    })
    .catch(() => undefined);
});

export function setPhoneRetirementHandler(
  eraseDeployment: (deploymentId: string) => Promise<unknown>,
): () => void {
  retirementHandler = eraseDeployment;
  return () => {
    if (retirementHandler === eraseDeployment) retirementHandler = null;
  };
}

export async function enrollAndroidPhone(input: {
  readonly hostClient: HostClient;
  readonly deploymentId: string;
  readonly name: string;
}): Promise<{ readonly enrollmentId: string }> {
  const host = await phoneEnrollmentHost(input.hostClient, input.deploymentId);
  return connection().enrollFromHost({
    ...host,
    apiVersion: hostApiVersion,
    deploymentId: input.deploymentId,
    name: input.name,
  });
}

const unsupported = async (): Promise<never> => {
  throw new Error("This phone does not share iPhone apps.");
};

export const androidPhoneBridge: IphoneAppsBridge | null =
  native === null
    ? null
    : {
        getSnapshot: () => connection().getSnapshot(),
        subscribe: (listener) => {
          const subscription = connection().addListener("onChange", listener);
          return () => subscription.remove();
        },
        prepare: (input) => connection().prepare(input),
        enroll: unsupported,
        discardPendingEnrollment: () => connection().discardPendingEnrollment(),
        retarget: (input) => connection().retarget(input),
        disconnect: () => connection().disconnect(),
        requestPermission: unsupported,
        chooseContacts: unsupported,
        choosePhotos: unsupported,
      };
