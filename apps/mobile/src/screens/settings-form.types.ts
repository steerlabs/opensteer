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

export interface EngineUpdateRow {
  readonly detail: string;
  readonly driverKind: string;
  readonly environmentId: string;
  readonly key: string;
  readonly name: string;
  readonly updateEnabled: boolean;
  readonly updating: boolean;
}

/** The open Deployment's pages for what agents use, which belong to it. */
export interface SignInsSettingsActions {
  readonly onBrowserProfiles: () => void;
  readonly onChrome: () => void;
  readonly onConnectedApps: () => void;
  readonly onPlugins: () => void;
}

export interface SettingsFormActionHandlers {
  readonly onAccountAction: () => void;
  readonly onComputerAction: (destination: ComputerSettingsDestination) => void;
  readonly onDeploymentAction: () => void;
  readonly onEngineUpdate?: ((environmentId: string, driverKind: string) => void) | undefined;
  readonly onNotificationAction: () => void;
  readonly onPasswordsAction: () => void;
  readonly onPreferenceChange: (kind: "approvals" | "run-outcomes", enabled: boolean) => void;
  readonly onAgentMuteChange: (workspaceId: string, muted: boolean) => void;
}

export interface RemoteAdministrationSettings {
  readonly access: import("@opensteer/protocol").PersonalRemoteAdministrationStatus | null;
  readonly pairing: import("@opensteer/protocol").IssuePersonalPairingCodeResponse | null;
  readonly sessions: readonly import("@opensteer/core").AuthSessionSummary[];
  readonly error: string | null;
  readonly busy: boolean;
  readonly onAction: (
    action: "off" | "connect" | "private" | "rotate" | "unlink" | "recover" | "pair" | "link",
  ) => void;
  readonly onRemove: (session: import("@opensteer/core").AuthSessionSummary) => void;
  readonly onRefresh: () => void;
}

export interface ConnectedAgentsSettings {
  readonly workspaces: readonly { id: string; name: string }[];
  readonly connections: readonly import("@opensteer/protocol").AgentConnection[] | null;
  readonly error: string | null;
  readonly pending: string | null;
  readonly onRefresh: () => void;
  readonly onRevoke: (id: string) => void;
}
export interface SettingsFormProps extends SettingsFormActionHandlers {
  readonly connectedAgents?: ConnectedAgentsSettings | undefined;
  readonly administration?: RemoteAdministrationSettings | undefined;
  /** Null in a build without an Account service. */
  readonly account: AccountSettingsModel | null;
  readonly accountError: string | null;
  /** The agents of the open Deployment; empty while none is open. */
  readonly agents: readonly AgentNotificationRow[];
  /** Where the open Opensteer runs and its computers; empty while none is open. */
  readonly computers: readonly ComputerSettingsRow[];
  readonly deployment: DeploymentSettingsModel;
  readonly engineUpdates?: readonly EngineUpdateRow[] | undefined;
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
