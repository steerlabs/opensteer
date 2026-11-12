import type { editAutomaticRole } from "@opensteer/client/host";
import type { AutomaticModelConfig, AutomaticModelRole, HarnessInstanceId } from "@opensteer/core";
import type { AutomaticModelsView } from "@opensteer/protocol";
import type { DeploymentUpdateModel } from "./use-deployment-update.js";
import type {
  ComputerSettingsDestination,
  ComputerSettingsRow,
  DeploymentSettingsModel,
  NotificationSettingsModel,
  PasswordsSettingsModel,
} from "./settings-model.js";

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

export interface AiAccountAction {
  readonly id: "make-default" | "refresh-models" | "remove" | "sign-in";
  readonly label: string;
}

export interface AiAccountRow {
  /** Set only when the line under the name is something to act on. */
  readonly attention: "bad" | "warn" | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly line: string | null;
  readonly menu: readonly AiAccountAction[];
  readonly name: string;
  readonly primary: AiAccountAction | null;
}

/** The accounts of one engine on the chosen computer. */
export interface AiEngineAccounts {
  readonly addable: boolean;
  readonly driverKind: string;
  readonly name: string;
  readonly rows: readonly AiAccountRow[];
}

export interface AiAccountsForm {
  /** The account whose action is under way; every other action waits for it. */
  readonly busyId: string | null;
  readonly confirmation: string | null;
  readonly error: string | null;
  readonly groups: readonly AiEngineAccounts[];
  readonly locationId: string | null;
  /** Empty with only one computer to choose. */
  readonly locations: readonly { readonly id: string; readonly title: string }[];
  readonly onAction: (harnessInstanceId: string, action: AiAccountAction) => void;
  readonly onAdd: (driverKind: string) => void;
  readonly onChooseLocation: (environmentId: string) => void;
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
  readonly onComputerAction: (destination: ComputerSettingsDestination) => void;
  readonly onDeploymentAction: () => void;
  readonly onEngineUpdate?: ((environmentId: string, driverKind: string) => void) | undefined;
  readonly onNotificationAction: () => void;
  readonly onPasswordsAction: () => void;
  readonly onPreferenceChange: (kind: "approvals" | "run-outcomes", enabled: boolean) => void;
}

export type SettingsPage =
  "general" | "account" | "devices" | "ai" | "sign-ins" | "external-agents";

/** After how long quiet tasks move to Done, on a Host that moves them. */
export interface QuietTasksSetting {
  readonly days: import("@opensteer/core").QuietTaskDays;
  readonly error: string | null;
  readonly onChange: (days: import("@opensteer/core").QuietTaskDays) => void;
}

export interface SettingsFormProps extends SettingsFormActionHandlers {
  readonly page?: SettingsPage;
  /** Where the open Opensteer runs and its computers; empty while none is open. */
  readonly computers: readonly ComputerSettingsRow[];
  readonly deployment: DeploymentSettingsModel;
  /** Null when there is no open Deployment, or its Host refuses this person. */
  readonly desktopUpdate: DeploymentUpdateModel | null;
  readonly engineUpdates?: readonly EngineUpdateRow[] | undefined;
  /** Null while no Deployment is open. */
  readonly automatic?: AutomaticModelsForm | null | undefined;
  readonly aiAccounts?: AiAccountsForm | null | undefined;
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
