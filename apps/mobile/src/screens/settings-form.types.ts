import type {
  AccountSettingsModel,
  ComputerSettingsDestination,
  ComputerSettingsRow,
  DeploymentSettingsModel,
  NotificationSettingsModel,
  PasswordsSettingsModel,
} from "./settings-model.js";

/**
 * One agent whose notifications can be silenced.
 *
 * Muting one silences its replies and the work it could not finish, not
 * approvals and questions: its messages still count as unread, and its work
 * keeps running. The section says so, because a mute people are afraid of is
 * a mute nobody uses.
 */
export interface AgentNotificationRow {
  readonly muted: boolean;
  readonly name: string;
  readonly workspaceId: string;
}

/** The open Deployment's sign-in pages, which belong to it. */
export interface SignInsSettingsActions {
  readonly onBrowserProfiles: () => void;
  readonly onChrome: () => void;
  readonly onConnectedApps: () => void;
}

export interface SettingsFormActionHandlers {
  readonly onAccountAction: () => void;
  readonly onComputerAction: (destination: ComputerSettingsDestination) => void;
  readonly onDeploymentAction: () => void;
  readonly onNotificationAction: () => void;
  readonly onPasswordsAction: () => void;
  readonly onPreferenceChange: (kind: "approvals" | "run-outcomes", enabled: boolean) => void;
  readonly onAgentMuteChange: (workspaceId: string, muted: boolean) => void;
}

export interface SettingsFormProps extends SettingsFormActionHandlers {
  /** Null in a build without an Account service. */
  readonly account: AccountSettingsModel | null;
  readonly accountError: string | null;
  /** The agents of the open Deployment; empty while none is open. */
  readonly agents: readonly AgentNotificationRow[];
  /** Where the open Opensteer runs and its computers; empty while none is open. */
  readonly computers: readonly ComputerSettingsRow[];
  readonly deployment: DeploymentSettingsModel;
  readonly notificationError: string | null;
  /** Null in a build without an Account service, which nothing can notify. */
  readonly notifications: NotificationSettingsModel | null;
  /** Where saved passwords are kept; null while no Deployment is open. */
  readonly passwords: PasswordsSettingsModel | null;
  /** Null while no Deployment is open. */
  readonly signIns: SignInsSettingsActions | null;
  readonly storageError: string | null;
  readonly version: string;
}
