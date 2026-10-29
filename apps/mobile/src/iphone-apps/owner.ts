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
  /** The Host's Runner id, only once added. */
  readonly machineId: string | null;
  readonly name: string;
}

/**
 * What the phone's session lifecycle needs from this iPhone, with no await
 * between deciding and stopping.
 */
export interface IphoneAppsOwner {
  /** The Deployment this iPhone shares its apps with, or is being added to. */
  enrolledDeploymentId(): string | null;
  /** Stops sharing synchronously; nothing new runs once this returns. */
  stop(): IphoneAppsStopped | null;
  /** Tells the Host, bounded; a Host that cannot be told is the person's notice. */
  tellHost(stopped: IphoneAppsStopped, dispatch: HostClient["dispatch"] | null): Promise<void>;
}
