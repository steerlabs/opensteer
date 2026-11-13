import type { HostClient } from "@opensteer/client/host";

/*
 * The seam between the phone's session lifecycle and this iPhone's apps. It
 * imports nothing platform-specific, so the session client stays free of the
 * native module and of React Native's globals.
 */

export interface IphoneAppsStopped {
  readonly deploymentId: string;
  readonly deploymentName: string | null;
  readonly enrollmentId: string | null;
  /** A signed leave was persisted natively before the stop erased its key. */
  readonly left: boolean;
  readonly leaveRunnerId?: string;
  /** The Host's Runner id, only once added. */
  readonly machineId: string | null;
  readonly name: string;
  /** The Host confirmed this Deployment's session is bound to this phone, so leaving ends it. */
  readonly sessionBound: boolean;
}

/** `unconfirmed`: fenced and erased here, but the Host has not said so yet. */
export type IphoneLeaveOutcome = "removed" | "unconfirmed";

/**
 * What the phone's session lifecycle needs from this iPhone, with no await
 * between deciding and stopping.
 */
export interface IphoneAppsOwner {
  /** The Deployment this iPhone shares its apps with, or is being added to. */
  enrolledDeploymentId(): string | null;
  removedDeploymentId?(): string | null;
  automaticSignInAllowed?(): boolean;
  /** Leaves synchronously: the signed leave is durable, then nothing new runs. */
  stop(): IphoneAppsStopped | null;
  /** Tells the Host, bounded; a Host that cannot be told is the person's notice. */
  tellHost(
    stopped: IphoneAppsStopped,
    dispatch: HostClient["dispatch"] | null,
  ): Promise<IphoneLeaveOutcome>;
  /** Whether this Deployment's session open here is bound to this phone. */
  sessionBound(deploymentId: string): boolean;
  /** The Host removed this phone (4010); the listener fences that Deployment's sign-in. */
  onRemoved(listener: (deploymentId: string) => void): () => void;
}
