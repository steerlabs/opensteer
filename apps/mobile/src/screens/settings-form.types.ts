import type { editAutomaticRole } from "@opensteer/client/host";
import type { AutomaticModelConfig, AutomaticModelRole, HarnessInstanceId } from "@opensteer/core";
import type { AutomaticModelsView } from "@opensteer/protocol";
import type { DeploymentUpdateModel } from "./use-deployment-update.js";
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

/** Which models do Opensteer's own small jobs; null settings while loading. */
export interface AutomaticModelsForm {
  readonly supported: boolean;
  readonly view: AutomaticModelsView | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly explanation: boolean;
  readonly dismiss: () => void;
  readonly save: (make: () => AutomaticModelConfig) => void;
  readonly edit: (
    role: AutomaticModelRole,
    action: Parameters<typeof editAutomaticRole>[2],
  ) => void;
  readonly toggle: (id: HarnessInstanceId) => void;
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
  readonly onChooseModel?: (() => void) | undefined;
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
    action:
      "off" | "connect" | "private" | "rotate" | "unlink" | "recover" | "pair" | "link" | "mode",
  ) => void;
  readonly onRemove: (session: import("@opensteer/core").AuthSessionSummary) => void;
  readonly onRefresh: () => void;
}

export type SettingsPage = "general" | "account" | "devices" | "ai" | "sign-ins";

/** After how long quiet tasks move to Done, on a Host that moves them. */
export interface QuietTasksSetting {
  readonly days: import("@opensteer/core").QuietTaskDays;
  readonly error: string | null;
  readonly onChange: (days: import("@opensteer/core").QuietTaskDays) => void;
}

export interface SettingsFormProps extends SettingsFormActionHandlers {
  readonly page?: SettingsPage;
  readonly administration?: RemoteAdministrationSettings | undefined;
  /** Null in a build without an Account service. */
  readonly account: AccountSettingsModel | null;
  readonly accountError: string | null;
  /** The agents of the open Deployment; empty while none is open. */
  readonly agents: readonly AgentNotificationRow[];
  /** Where the open Opensteer runs and its computers; empty while none is open. */
  readonly computers: readonly ComputerSettingsRow[];
  readonly deployment: DeploymentSettingsModel;
  /** Null when there is no open Deployment, or its Host refuses this person. */
  readonly desktopUpdate: DeploymentUpdateModel | null;
  readonly engineUpdates?: readonly EngineUpdateRow[] | undefined;
  /** Null while no Deployment is open. */
  readonly automatic?: AutomaticModelsForm | null | undefined;
  readonly notificationError: string | null;
  /** Null in a build without an Account service, which nothing can notify. */
  readonly notifications: NotificationSettingsModel | null;
  /** Where saved passwords are kept; null while no Deployment is open. */
  readonly passwords: PasswordsSettingsModel | null;
  /** Null while the open Host does not move quiet tasks to Done. */
  readonly quietTasks?: QuietTasksSetting | null | undefined;
  /** Null while no Deployment is open. */
  readonly signIns: SignInsSettingsActions | null;
  readonly storageError: string | null;
  readonly version: string;
}
