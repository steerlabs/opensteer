export type IphoneBaseAppId = "apple-calendar" | "apple-contacts" | "apple-reminders";
/** Older builds omit apps they do not offer from permissions. */
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
  readonly createdAt: string;
  readonly expiresAt: string;
}
/** A signed self-leave persisted natively, waiting for its Host; older builds omit it. */
export interface IphonePendingLeave {
  readonly deploymentId: string;
  readonly runnerId: string;
  readonly hostUrl: string;
  readonly issuedAt: string;
  readonly signature: string;
  readonly devicesV1?: boolean | null;
  readonly hostInstanceId?: string | null;
  readonly enrollmentId?: string | null;
  readonly enrolled?: boolean | null;
  readonly preparedIdentity?: { readonly runnerId: string; readonly publicKeyPem: string } | null;
  readonly profile?: "iphone" | null;
  readonly mintKey?: string | null;
  readonly name?: string | null;
}
export interface IphoneSessionBinding {
  readonly runnerId: string;
  readonly issuedAt: string;
  readonly signature: string;
}
export interface IphoneAppsSnapshot {
  readonly removedFrom?: { readonly deploymentId: string; readonly deploymentName: string } | null;
  readonly pendingLeaves?: readonly IphonePendingLeave[];
  readonly lifecycleReady?: boolean;
  readonly pendingErasure?: boolean;
  readonly pendingLeave?: IphonePendingLeave | null;
  readonly revision: number;
  readonly supported: boolean;
  readonly unsupportedReason: "not-ios" | "not-iphone" | "ios-version" | null;
  readonly deviceName: string;
  readonly enrollment: IphoneAppsEnrollment | null;
  readonly connection: IphoneAppsConnection;
  readonly retryAt: string | null;
  readonly issue: IphoneAppsIssue | null;
  readonly issueMessage: string | null;
  /** The apps this device can share, each as iOS answers for it; a phone with none has none. */
  readonly permissions: Readonly<Partial<Record<IphoneAppId, IphonePermission>>>;
  /** Whether iPhone Settings gives Location precisely; null unless it is granted. Older builds omit it. */
  readonly locationAccuracy?: "approximate" | "precise" | null;
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
    readonly publicKeyPem?: string;
  }>;
  beginIssuance?(input: {
    readonly name: string;
    readonly pairing: IphonePairingTarget;
    readonly devicesV1: boolean;
  }): Promise<void>;
  clearRemoved?(): Promise<void>;
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
  /** The signed leave must be durable before native key erasure. */
  leave(): {
    readonly deploymentId: string | null;
    readonly runnerId: string | null;
    readonly leave?: "persisted";
  };
  completeLeave(input: { readonly runnerId: string }): Promise<void>;
  signSessionBinding(input: {
    readonly deploymentId: string;
    readonly sessionId: string;
  }): Promise<IphoneSessionBinding>;
  requestPermission(app: IphoneAppId): Promise<IphonePermission>;
  chooseContacts(): Promise<IphonePermission>;
  /** Apple's limited-library picker, from a tap; what comes back is iOS's answer read afresh. */
  choosePhotos(): Promise<IphonePermission>;
}
