import type {
  BrowserProfileId,
  BrowserSessionId,
  DeploymentId,
  RunId,
  RunnerId,
  TaskFolder,
  ThreadId,
  UserId,
} from "@opensteer/core";

export interface PrivateResourceActor {
  readonly ownerId: UserId;
  readonly deploymentId: DeploymentId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
}
export interface PrivateIntegrationGrant {
  readonly connectionId: string;
  readonly access: "read" | "read-write";
  readonly alias: string | null;
}
export interface PrivateBrowserProfile {
  readonly id: BrowserProfileId;
  readonly homeComputerId: RunnerId;
  readonly storageBindingVersion: number;
  readonly archived: boolean;
}
export interface PrivateResourceStorePort {
  assertOwner(actor: PrivateResourceActor): Promise<void>;
  integrationGrants(actor: PrivateResourceActor): Promise<readonly PrivateIntegrationGrant[]>;
  setIntegrationGrant(actor: PrivateResourceActor, grant: PrivateIntegrationGrant): Promise<void>;
  revokeIntegrationGrant(actor: PrivateResourceActor, connectionId: string): Promise<void>;
  browserProfiles(actor: PrivateResourceActor): Promise<readonly PrivateBrowserProfile[]>;
  assertBrowserProfile(
    actor: PrivateResourceActor,
    profileId: BrowserProfileId,
    computerId: RunnerId,
  ): Promise<PrivateBrowserProfile>;
  attachBrowserSession(actor: PrivateResourceActor, sessionId: BrowserSessionId): Promise<void>;
  detachBrowserSession(actor: PrivateResourceActor, sessionId: BrowserSessionId): Promise<void>;
  passwordsGrant(
    actor: PrivateResourceActor,
    site: string,
  ): Promise<{ readonly loginId: string; readonly revision: number } | null>;
  revokePasswordsGrant(actor: PrivateResourceActor, site: string): Promise<void>;
  messagingFolder(actor: PrivateResourceActor, bindingId: string): Promise<TaskFolder>;
  setMessagingFolder(
    actor: PrivateResourceActor,
    bindingId: string,
    folder: TaskFolder,
  ): Promise<void>;
  appPublisher(
    actor: PrivateResourceActor,
    appId: string,
  ): Promise<{
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly folder: TaskFolder | null;
  }>;
}
