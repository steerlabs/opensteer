import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/** Apps every iPhone build shares. */
export type IphoneBaseAppId = "apple-calendar" | "apple-contacts" | "apple-reminders";
/**
 * Apps added after the first iPhone builds. An installed build that predates
 * one omits it from `permissions`; that absence is the only local sign that
 * this build does not offer it.
 */
export type IphoneAddedAppId = "iphone-location" | "iphone-photos";
export type IphoneAppId = IphoneAddedAppId | IphoneBaseAppId;
export type IphonePermission =
  "not-determined" | "granted" | "limited" | "write-only" | "denied" | "restricted";
export interface IphonePairingTarget {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly hostInstanceId: string;
  readonly hostUrl: string;
}
export type IphoneAppsConnection =
  "none" | "connecting" | "online" | "retrying" | "background" | "stopped";
export type IphoneAppsIssue =
  | "enrollment-expired"
  | "enrollment-refused"
  | "host-unreachable"
  | "host-mismatch"
  | "remote-access-off"
  | "removed"
  | "needs-update"
  | "profile-mismatch"
  | "protocol-error"
  | "failed";
export interface IphoneAppsEnrollment {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly runnerId: string;
  readonly name: string;
  readonly state: "pending" | "enrolled";
  readonly enrollmentId: string | null;
  readonly hostUrl: string;
}
export interface IphoneAppsApproval {
  readonly setupRequestId: string;
  readonly definitionId: IphoneAppId;
  readonly access: "read" | "read-write";
  readonly reason: string | null;
  readonly threadTitle: string | null;
  readonly workspaceName: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface IphoneAppsSnapshot {
  readonly revision: number;
  readonly supported: boolean;
  readonly unsupportedReason: "not-ios" | "not-iphone" | "ios-version" | null;
  readonly deviceName: string;
  readonly enrollment: IphoneAppsEnrollment | null;
  readonly connection: IphoneAppsConnection;
  readonly retryAt: string | null;
  readonly issue: IphoneAppsIssue | null;
  readonly issueMessage: string | null;
  readonly approvalKey: {
    readonly keyId: string;
    readonly publicKey: string;
    readonly registered: boolean;
  } | null;
  readonly permissions: Readonly<
    Record<IphoneBaseAppId, IphonePermission> & Partial<Record<IphoneAddedAppId, IphonePermission>>
  >;
  /** Whether iPhone Settings gives Location precisely; null unless it is granted. Older builds omit it. */
  readonly locationAccuracy?: "approximate" | "precise" | null;
  readonly approvals: readonly IphoneAppsApproval[];
  readonly working: number;
}
export type IphoneApprovalOutcome =
  | { readonly kind: "allowed" }
  | { readonly kind: "declined" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };
export type IphoneAppsErrorCode =
  | "unsupported"
  | "enrolled-elsewhere"
  | "not-prepared"
  | "wrong-deployment"
  | "invalid-target"
  | "not-foreground"
  | "busy";
export interface IphoneAppsBridge {
  getSnapshot(): IphoneAppsSnapshot;
  subscribe(listener: (snapshot: IphoneAppsSnapshot) => void): () => void;
  prepare(input: { readonly deploymentId: string }): Promise<{
    readonly runnerId: string;
    readonly mintKey: string;
  }>;
  enroll(input: {
    readonly pairing: IphonePairingTarget;
    readonly enrollmentId: string;
    readonly enrollmentToken: string;
    readonly expiresAt: string;
    readonly name: string;
  }): Promise<void>;
  discardPendingEnrollment(): Promise<{ readonly mintKey: string }>;
  retarget(pairing: IphonePairingTarget): Promise<void>;
  disconnect(): { readonly deploymentId: string | null; readonly runnerId: string | null };
  requestPermission(app: IphoneAppId): Promise<IphonePermission>;
  chooseContacts(): Promise<IphonePermission>;
  /** Apple's limited-library picker, from a tap; what comes back is iOS's answer read afresh. */
  choosePhotos(): Promise<IphonePermission>;
  answerApproval(input: {
    readonly setupRequestId: string;
    readonly decision: "allow" | "deny";
    readonly expected: {
      readonly definitionId: IphoneAppId;
      readonly access: "read" | "read-write";
    };
  }): Promise<IphoneApprovalOutcome>;
}

interface NativeIphoneApps extends Omit<IphoneAppsBridge, "choosePhotos" | "subscribe"> {
  /** Absent from builds that predate Photos. */
  readonly choosePhotos?: () => Promise<IphonePermission>;
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
  approvalKey: null,
  permissions: {
    "apple-calendar": "not-determined",
    "apple-contacts": "not-determined",
    "apple-reminders": "not-determined",
  },
  locationAccuracy: null,
  approvals: [],
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
  requestPermission: async () => {
    throw unsupportedError();
  },
  chooseContacts: async () => {
    throw unsupportedError();
  },
  choosePhotos: async () => {
    throw unsupportedError();
  },
  answerApproval: async () => {
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
        enroll: (input) => native.enroll(input),
        discardPendingEnrollment: () => native.discardPendingEnrollment(),
        retarget: (pairing) => native.retarget(pairing),
        disconnect: () => native.disconnect(),
        requestPermission: (app) => native.requestPermission(app),
        chooseContacts: () => native.chooseContacts(),
        choosePhotos: async () => {
          if (native.choosePhotos === undefined) throw unsupportedError();
          return native.choosePhotos();
        },
        answerApproval: (input) => native.answerApproval(input),
      };
