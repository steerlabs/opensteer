import { hostsDeployment, type ComputerGlyph } from "@opensteer/client/computers";
import {
  passwordsElsewhere,
  passwordsCardsFact,
  passwordsHowItWorks,
  passwordsSettingsLabel,
  passwordsSettingsSubtitle,
} from "@opensteer/client/host";
import { otherDeviceLine, type OtherDeviceLine } from "@opensteer/client/settings";
import { maximumNotificationDevicesPerAccount } from "@opensteer/core";
import type { HarnessInstallation, MachineSummary, OtherDevice } from "@opensteer/protocol";
import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { deploymentStatusLabel, type DeploymentRow } from "../client/deployment-rows.js";
import type {
  NotificationPreferences,
  PushRegistrationState,
} from "../notifications/push-registration.js";
import { deploymentMark, type DeploymentMark } from "../threads/deployment-identity.js";

interface SettingsActionBase {
  readonly destructive?: boolean;
  readonly disabled: boolean;
  readonly label: string;
}

export interface AccountSettingsActionModel extends SettingsActionBase {
  readonly kind: "sign-in" | "sign-out";
}

export interface NotificationSettingsActionModel extends SettingsActionBase {
  readonly kind: "open-settings" | "request-permission" | "retry-notifications";
}

export interface DeploymentSettingsActionModel extends SettingsActionBase {
  readonly kind: "switch-deployment";
}

export type SettingsActionModel =
  AccountSettingsActionModel | DeploymentSettingsActionModel | NotificationSettingsActionModel;

export interface DeploymentSettingsModel {
  readonly action: DeploymentSettingsActionModel;
  /** The deployment's identity mark, or null when none is selected to draw. */
  readonly mark: DeploymentMark | null;
  readonly status: string;
  readonly title: string;
}

export interface AccountSettingsModel {
  readonly action: AccountSettingsActionModel | null;
  readonly detail: string | null;
  /**
   * One letter for the signed-in person's avatar, or null when nobody is: an
   * avatar for an absent account would be a face drawn for no face.
   */
  readonly initial: string | null;
  readonly subtitle: string | null;
  readonly title: string;
}

export function engineInstallationUpdateModel(
  installation: HarnessInstallation,
  locallyPending: boolean,
): { readonly detail: string; readonly updateEnabled: boolean; readonly updating: boolean } {
  if (locallyPending) {
    return { detail: "Updating…", updateEnabled: false, updating: true };
  }
  switch (installation.update) {
    case "available":
      return {
        detail: `Update available${installation.latestVersion ? ` · ${installation.latestVersion}` : ""}`,
        updateEnabled: true,
        updating: false,
      };
    case "current":
      return { detail: "Up to date", updateEnabled: false, updating: false };
    case "manual":
      return {
        detail: installation.detail ?? "Update on its computer.",
        updateEnabled: false,
        updating: false,
      };
    case "unknown":
      return {
        detail: installation.detail ?? "Update status unavailable.",
        updateEnabled: true,
        updating: false,
      };
    case "updating":
      return { detail: "Updating…", updateEnabled: false, updating: true };
    case "succeeded":
      return { detail: "Updated", updateEnabled: false, updating: false };
    case "failed":
      return {
        detail: installation.detail ?? "Update failed.",
        updateEnabled: true,
        updating: false,
      };
  }
}

export interface NotificationSettingsModel {
  readonly action: NotificationSettingsActionModel | null;
  /** Why notifications can't reach this phone yet; null once they can. */
  readonly detail: string | null;
  readonly disabled: boolean;
  /** What notifications on this phone can and cannot reach, stated once. */
  readonly footer: string;
  readonly preferences: NotificationPreferences | null;
}

type AccountState = DesktopAccountAuthState["account"];

/** The selected work context, kept with the controls that manage connections. */
export function deploymentSettingsModel(row: DeploymentRow | null): DeploymentSettingsModel {
  if (row === null) {
    return {
      action: { disabled: false, kind: "switch-deployment", label: "Choose" },
      mark: null,
      status: "Choose where your work is running.",
      title: "No deployment selected",
    };
  }
  return {
    action: { disabled: false, kind: "switch-deployment", label: "Switch" },
    mark: deploymentMark(row),
    status: deploymentStatusLabel(row.status),
    title: row.name,
  };
}

/** The Account section as facts and actions, independent of either platform renderer. */
export const privacyPolicyUrl = "https://opensteer.com/privacy";

/** Null in a build without an Account service, which has nothing to sign in to. */
export function accountSettingsModel(
  account: AccountState,
  working: boolean,
): AccountSettingsModel | null {
  const identity = account.identity;
  if (identity !== null) {
    return {
      action: {
        destructive: true,
        disabled: working,
        kind: "sign-out",
        label: working ? "Signing out…" : "Sign out of Account",
      },
      detail:
        "Account sign-out removes deployments listed by your Account from this phone. Deployments you added yourself stay signed in.",
      initial: accountInitial(identity.email ?? identity.subject),
      subtitle: identity.issuer,
      title: identity.email ?? identity.subject,
    };
  }

  if (!account.available) return null;
  const authorizing = account.status === "authorizing";
  return {
    action: {
      disabled: working || authorizing,
      kind: "sign-in",
      label:
        working || authorizing
          ? "Signing in…"
          : account.status === "error"
            ? "Try Account sign-in again"
            : "Sign in with Opensteer",
    },
    detail:
      account.detail ?? "Sign in to sync the deployments your Account lists and get notifications.",
    initial: null,
    subtitle: null,
    title: authorizing ? "Finish signing in in your browser" : "No Opensteer Account",
  };
}

/**
 * One letter for the avatar. An address is taken at its local part, because
 * the letter a person recognises is the first of their own name and never the
 * first of whichever provider hosts their mail.
 */
function accountInitial(identity: string): string | null {
  const local = identity.split("@")[0] ?? "";
  for (const character of local) {
    if (character.trim() !== "") return character.toLocaleUpperCase();
  }
  return null;
}

/**
 * The boundary of the notification path, said once under the section rather
 * than repeated in every state above it: the Account is the only thing that
 * can reach this phone, so a deployment it does not list cannot notify at all.
 */
const notificationFooter = "Only deployments your Opensteer Account lists can notify this phone.";

/**
 * The notification state machine translated into the one useful next action,
 * if any. Null in a build without an Account service, which nothing can notify.
 */
export function notificationSettingsModel(
  state: PushRegistrationState,
  working: boolean,
): NotificationSettingsModel | null {
  switch (state.status) {
    case "registered":
      return {
        action: null,
        detail: null,
        disabled: working,
        footer: notificationFooter,
        preferences: state.preferences,
      };
    case "no-account-service":
      return null;
    case "signed-out":
      return {
        action: null,
        detail: "Sign in to your Opensteer Account to receive notifications on this phone.",
        disabled: working,
        footer: notificationFooter,
        preferences: null,
      };
    case "permission-undetermined":
      return {
        action: {
          disabled: working,
          kind: "request-permission",
          label: working ? "Turning on…" : "Turn on notifications",
        },
        detail: "Opensteer needs your permission before it can notify you.",
        disabled: working,
        footer: notificationFooter,
        preferences: null,
      };
    case "permission-denied":
      return {
        action: { disabled: working, kind: "open-settings", label: "Open phone settings" },
        detail: "Notifications are off for Opensteer in this phone’s settings.",
        disabled: working,
        footer: notificationFooter,
        preferences: null,
      };
    case "push-not-configured":
      return {
        action: null,
        detail: "Your Opensteer Account service is not configured to send notifications.",
        disabled: working,
        footer: notificationFooter,
        preferences: null,
      };
    case "device-limit":
      return {
        action: {
          disabled: working,
          kind: "retry-notifications",
          label: working ? "Trying again…" : "Try again",
        },
        detail: `Your Account already has ${maximumNotificationDevicesPerAccount} phones registered. Remove one from Settings on another phone, then try again.`,
        disabled: working,
        footer: notificationFooter,
        preferences: null,
      };
    case "unavailable":
      return {
        action: {
          disabled: working,
          kind: "retry-notifications",
          label: working ? "Trying again…" : "Try again",
        },
        detail: state.detail,
        disabled: working,
        footer: notificationFooter,
        preferences: null,
      };
  }
}

export const browserProfilesSettingsRow = {
  detail: "Separate browsers with their own sign-ins",
  title: "Browser profiles",
} as const;

/** Chrome is connected from a computer; the phone sees it and manages allowed sites. */
/** The section of what agents can reach: accounts, plugins, browsers and passwords. */
export const agentAccessSectionTitle = "For agents";

export const connectedAppsSettingsRow = {
  detail: "Gmail, GitHub and the other accounts agents use",
  title: "Connections",
} as const;

/** Installed, then turned on or off, apart from what it may access. */
export const pluginsSettingsRow = {
  detail: "Skills, tools and specialists for your agents",
  title: "Plugins",
} as const;

export const chromeSettingsRow = {
  detail: "Your Chrome and the sites agents can sign in to",
  title: "Chrome",
} as const;
/** After how long a person's quiet tasks move to Done, as the Host accepts it. */
export const quietTaskChoices = [
  { days: 0, label: "Off" },
  { days: 1, label: "1 day" },
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
] as const;

export const quietTasksTitle = "Move quiet tasks to Done";

export const quietTasksFooter =
  "Finished tasks you’ve read, with nothing waiting on you, move to Done after this long.";

/**
 * Passwords live in the Opensteer app on the Mac that runs a Personal
 * Opensteer. A phone is never that Mac, so the row only says where they are,
 * while approval uses the phone’s own device-owner authentication.
 */
export interface PasswordsSettingsModel {
  readonly body: string;
  readonly detail: string;
  readonly facts: readonly string[];
  readonly title: string;
}

export function passwordsSettingsModel(input: {
  /** A Personal Opensteer is named after its Mac until that Mac reports itself. */
  readonly deploymentName: string;
  readonly machines: readonly MachineSummary[];
}): PasswordsSettingsModel {
  const personal = true;
  const homeName = input.machines.find(hostsDeployment)?.name ?? input.deploymentName;
  return {
    body: passwordsElsewhere({ homeName, personal }),
    detail: passwordsSettingsSubtitle({ homeName, personal }),
    facts: personal
      ? [
          passwordsHowItWorks[0],
          passwordsCardsFact,
          "You can allow or decline a sign-in from this phone. Allowing first confirms it’s you on this device.",
          `In Opensteer’s browser, tap a sign-in field to fill your own saved login. ${homeName} types it; it never comes to this phone.`,
          `When you sign in by hand there, Opensteer offers to save that login on ${homeName}. The password stays there.`,
        ]
      : [],
    title: passwordsSettingsLabel,
  };
}

/** The system's own picture of each kind of place. */
export type ComputerSymbol =
  "desktopcomputer" | "laptopcomputer" | "macmini" | "server.rack" | "smartphone";

/** Each computer's shape as the symbol it is drawn with. */
export const computerSymbols: Readonly<Record<ComputerGlyph, ComputerSymbol>> = {
  compact: "macmini",
  computer: "desktopcomputer",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  phone: "smartphone",
  server: "server.rack",
};

/** One row of Settings → Devices → Other devices: a device a plugin's server reaches. */
export interface OtherDeviceSettingsRow {
  readonly detail: string;
  readonly key: string;
  readonly name: string;
  readonly opens: OtherDeviceLine["opens"];
  readonly symbol: OtherDeviceSymbol;
}

export type OtherDeviceSymbol = "camera" | "hifispeaker" | "lightbulb" | "powerplug" | "tv";

const otherDeviceSymbols: Readonly<Record<OtherDevice["kind"], OtherDeviceSymbol>> = {
  camera: "camera",
  light: "lightbulb",
  other: "powerplug",
  speaker: "hifispeaker",
  tv: "tv",
};

/** `waiting` holds the Threads with a pending Request; a setup task there needs the person. */
export function otherDevicesSettingsRows(
  devices: readonly OtherDevice[],
  waiting: ReadonlySet<string>,
): readonly OtherDeviceSettingsRow[] {
  return devices.map((device) => {
    const line = otherDeviceLine(
      device,
      device.setupThreadId !== null && waiting.has(device.setupThreadId),
    );
    return {
      detail: line.detail,
      key: device.pluginId,
      name: device.name,
      opens: line.opens,
      symbol: otherDeviceSymbols[device.kind],
    };
  });
}

/** Registration needs the Account credential, so it must be revoked first. */
export async function signOutAccountInOrder(
  revokeNotificationRegistration: () => Promise<void>,
  revokeAccountCredential: () => Promise<void>,
): Promise<void> {
  await revokeNotificationRegistration();
  await revokeAccountCredential();
}

/** Where a signed-in device was last seen, in words a person reads at a glance. */
