import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type * from "./iphone-apps-types.js";
import type {
  IphoneAppsBridge,
  IphoneAppsErrorCode,
  IphoneAppsSnapshot,
  IphonePermission,
} from "./iphone-apps-types.js";

interface NativeIphoneApps extends Omit<
  IphoneAppsBridge,
  "choosePhotos" | "completeLeave" | "leave" | "signSessionBinding" | "subscribe"
> {
  /** Absent from builds that predate Photos. */
  readonly choosePhotos?: () => Promise<IphonePermission>;
  /** Absent from builds that predate device sessions. */
  readonly leave?: IphoneAppsBridge["leave"];
  readonly completeLeave?: IphoneAppsBridge["completeLeave"];
  readonly signSessionBinding?: IphoneAppsBridge["signSessionBinding"];
  addListener(
    event: "onChange",
    listener: (snapshot: IphoneAppsSnapshot) => void,
  ): {
    remove(): void;
  };
}

function unsupportedError(): Error & { code: IphoneAppsErrorCode } {
  return Object.assign(new Error("This iPhone cannot share its apps."), {
    code: "unsupported" as const,
  });
}

const unsupportedSnapshot: IphoneAppsSnapshot = {
  revision: 0,
  supported: false,
  unsupportedReason: Platform.OS === "ios" ? "ios-version" : "not-ios",
  deviceName: "iPhone",
  enrollment: null,
  connection: "none",
  retryAt: null,
  issue: null,
  issueMessage: null,
  permissions: {
    "apple-calendar": "not-determined",
    "apple-contacts": "not-determined",
    "apple-reminders": "not-determined",
  },
  locationAccuracy: null,
  working: 0,
};

const unsupported: IphoneAppsBridge = {
  getSnapshot: () => unsupportedSnapshot,
  subscribe: () => () => undefined,
  prepare: async () => {
    throw unsupportedError();
  },
  enroll: async () => {
    throw unsupportedError();
  },
  discardPendingEnrollment: async () => {
    throw unsupportedError();
  },
  retarget: async () => {
    throw unsupportedError();
  },
  disconnect: () => ({ deploymentId: null, runnerId: null }),
  leave: () => ({ deploymentId: null, runnerId: null }),
  completeLeave: async () => undefined,
  signSessionBinding: async () => {
    throw unsupportedError();
  },
  requestPermission: async () => {
    throw unsupportedError();
  },
  chooseContacts: async () => {
    throw unsupportedError();
  },
  choosePhotos: async () => {
    throw unsupportedError();
  },
};

const native =
  Platform.OS === "ios" ? requireOptionalNativeModule<NativeIphoneApps>("IphoneApps") : null;

export const iphoneApps: IphoneAppsBridge =
  native === null
    ? unsupported
    : {
        getSnapshot: () => native.getSnapshot(),
        subscribe: (listener) => {
          const subscription = native.addListener("onChange", listener);
          return () => subscription.remove();
        },
        prepare: (input) => native.prepare(input),
        beginIssuance: async (input) => {
          if (!native.beginIssuance) throw unsupportedError();
          await native.beginIssuance(input);
        },
        clearRemoved: () => native.clearRemoved?.() ?? Promise.resolve(),
        enroll: (input) => native.enroll(input),
        discardPendingEnrollment: () => native.discardPendingEnrollment(),
        retarget: (pairing) => native.retarget(pairing),
        disconnect: () => native.disconnect(),
        leave: () => (native.leave ?? native.disconnect)(),
        completeLeave: async (input) => {
          await native.completeLeave?.(input);
        },
        signSessionBinding: async (input) => {
          if (native.signSessionBinding === undefined) throw unsupportedError();
          return native.signSessionBinding(input);
        },
        requestPermission: (app) => native.requestPermission(app),
        chooseContacts: () => native.chooseContacts(),
        choosePhotos: async () => {
          if (native.choosePhotos === undefined) throw unsupportedError();
          return native.choosePhotos();
        },
      };
