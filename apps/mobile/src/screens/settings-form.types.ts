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
 * keeps running. The row says so, because a mute people are afraid of is a
 * mute nobody uses.
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

export interface SettingsFormActionHandlers {
  readonly onAccountAction: () => void;
  readonly onBrowserProfilesAction?: (() => void) | undefined;
  /** Absent while no Deployment is open: Chrome belongs to one. */
  readonly onChromeAction?: (() => void) | undefined;
  /** Absent while no Deployment is open: its accounts belong to one. */
  readonly onConnectedAppsAction?: (() => void) | undefined;
  readonly onComputerAction: (destination: ComputerSettingsDestination) => void;
  readonly onDeploymentAction: () => void;
  readonly onEngineUpdate?: ((environmentId: string, driverKind: string) => void) | undefined;
  readonly onNotificationAction: () => void;
  readonly onPasswordsAction: () => void;
  readonly onPreferenceChange: (kind: "approvals" | "run-outcomes", enabled: boolean) => void;
  readonly onAgentMuteChange: (workspaceId: string, muted: boolean) => void;
}

export interface SettingsFormProps extends SettingsFormActionHandlers {
  readonly account: AccountSettingsModel;
  readonly accountError: string | null;
  /** The agents of the open Deployment; empty while none is open. */
  readonly agents: readonly AgentNotificationRow[];
  /** Where the open Opensteer runs and its computers; empty while none is open. */
  readonly computers: readonly ComputerSettingsRow[];
  /** Under the computers: how each kind joins, and this iPhone when it can. */
  readonly computersFooter: string;
  readonly deployment: DeploymentSettingsModel;
  readonly engineUpdates?: readonly EngineUpdateRow[] | undefined;
  readonly notificationError: string | null;
  readonly notifications: NotificationSettingsModel;
  /** Where saved passwords are kept; null while no Deployment is open. */
  readonly passwords: PasswordsSettingsModel | null;
  readonly storageError: string | null;
  readonly version: string;
}
