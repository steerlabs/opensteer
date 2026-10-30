import {
  computerGlyph,
  computerRole,
  computerRoleLabel,
  computersOverview,
  computerStatus,
  computerUses,
  hostsDeployment,
  type ComputerAppsData,
  type ComputerGlyph,
  type DeploymentKind,
} from "@opensteer/client/computers";
import {
  passwordsElsewhere,
  passwordsSettingsLabel,
  passwordsSettingsSubtitle,
} from "@opensteer/client/host";
import { computerUseMachineLine, isAndroidPhone } from "@opensteer/client/integrations";
import { maximumNotificationDevicesPerAccount } from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { deploymentStatusLabel, type DeploymentRow } from "../client/deployment-rows.js";
import type {
  NotificationPreferences,
  PushRegistrationState,
} from "../notifications/push-registration.js";
import { deploymentMark, type DeploymentMark } from "../threads/deployment-switcher-model.js";

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

export interface NotificationSettingsModel {
  readonly action: NotificationSettingsActionModel | null;
  readonly detail: string;
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
      action: { disabled: false, kind: "switch-deployment", label: "Choose deployment" },
      mark: null,
      status: "Choose where your work is running.",
      title: "No deployment selected",
    };
  }
  return {
    action: { disabled: false, kind: "switch-deployment", label: "Switch deployment" },
    mark: deploymentMark(row),
    status: deploymentStatusLabel(row.status),
    title: row.name,
  };
}

/** The Account section as facts and actions, independent of either platform renderer. */
export function accountSettingsModel(
  account: AccountState,
  working: boolean,
): AccountSettingsModel {
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

  const authorizing = account.status === "authorizing";
  const available = account.available;
  return {
    action: available
      ? {
          disabled: working || authorizing,
          kind: "sign-in",
          label:
            working || authorizing
              ? "Signing in…"
              : account.status === "error"
                ? "Try Account sign-in again"
                : "Sign in with Opensteer",
        }
      : null,
    detail:
      account.detail ??
      (available
        ? "Sign in to sync the deployments your Account lists and enable notifications."
        : "This build was made without an Opensteer Account service."),
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
const notificationFooter =
  "Only deployments your Opensteer Account lists can notify this phone. Opening a notification attaches this phone to the deployment it names.";

/** The notification state machine translated into the one useful next action, if any. */
export function notificationSettingsModel(
  state: PushRegistrationState,
  working: boolean,
): NotificationSettingsModel {
  switch (state.status) {
    case "registered":
      return {
        action: null,
        detail: "This phone is registered with your Opensteer Account.",
        disabled: working,
        footer: notificationFooter,
        preferences: state.preferences,
      };
    case "no-account-service":
      return {
        action: null,
        detail: "This build has no Account service, so nothing can send this phone notifications.",
        disabled: working,
        footer: notificationFooter,
        preferences: null,
      };
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

/**
 * What computer use on a Mac or an agent phone needs from its owner, or is
 * doing, right now — the one thing worth reading about it from a phone before
 * its page is open. A Mac without the desktop app is not news; an agent phone
 * that cannot be used, because it is paused on the phone, is.
 */
function computerUseNow(machine: MachineSummary, hostConnected: boolean): string | null {
  const report = machine.computerUse;
  if (!report || machine.status !== "online") return null;
  return report.sessions.length > 0 ||
    report.state === "permission-required" ||
    (report.state === "unavailable" && isAndroidPhone(machine))
    ? computerUseMachineLine(machine, hostConnected)
    : null;
}

/**
 * A computer is added from itself and an Android phone from a computer it is
 * plugged into — never from this app — so the section says where.
 */
export const computersSettingsFooter =
  "To add a computer, open Opensteer on it and choose Add on its Computers page. To add an Android phone, plug it into a computer and choose Add a phone there.";

/** The footer under a list that offers to add this iPhone, which says what that shares. */
export function computersSettingsFooterFor(rows: readonly ComputerSettingsRow[]): string {
  return rows.some(({ opens }) => opens?.kind === "add-iphone")
    ? `Add this iPhone to let agents use its Calendar, Contacts and Reminders while Opensteer is open. ${computersSettingsFooter}`
    : computersSettingsFooter;
}

export const browserProfilesSettingsRow = {
  detail: "Separate browsers with their own sign-ins",
  title: "Browser profiles",
} as const;

/** Chrome is connected from a computer; the phone sees it and manages allowed sites. */
export const chromeSettingsRow = {
  detail: "Your Chrome and the sites agents can sign in to",
  title: "Chrome",
} as const;
export const chromeSettingsFooter =
  "Agents use websites you’re already signed in to in Chrome. You approve each site once.";

/**
 * Passwords live in the Opensteer app on the Mac that runs a Personal
 * Opensteer. A phone is never that Mac, so the row only says where they are,
 * and the one thing the phone can do about a sign-in.
 */
export interface PasswordsSettingsModel {
  readonly body: string;
  readonly detail: string;
  readonly facts: readonly string[];
  readonly title: string;
}

export function passwordsSettingsModel(input: {
  readonly deploymentKind: DeploymentKind | null;
  /** A Personal Opensteer is named after its Mac until that Mac reports itself. */
  readonly deploymentName: string;
  readonly machines: readonly MachineSummary[];
}): PasswordsSettingsModel {
  const personal = input.deploymentKind === "personal";
  const homeName =
    input.machines.find((machine) => hostsDeployment(machine, input.deploymentKind))?.name ??
    input.deploymentName;
  return {
    body: passwordsElsewhere({ homeName, personal }),
    detail: passwordsSettingsSubtitle({ homeName, personal }),
    facts: personal
      ? [
          `You allow an account once per Workspace, on ${homeName}, with Touch ID or your Mac password. After that, agents there sign in with it on their own.`,
          "You can say no to a sign-in from this phone.",
        ]
      : [],
    title: passwordsSettingsLabel,
  };
}

/** The system's own picture of each kind of place. */
export type ComputerSymbol =
  "cloud" | "desktopcomputer" | "laptopcomputer" | "macmini" | "server.rack" | "smartphone";

/** One row of Settings → Computers: where the Opensteer runs, or one computer. */
export interface ComputerSettingsRow {
  readonly detail: string;
  readonly key: string;
  /** What tapping the row opens, or null for a row that only says something. */
  readonly opens: ComputerSettingsDestination | null;
  readonly name: string;
  readonly symbol: ComputerSymbol;
}

/**
 * A computer's page — in the open Deployment unless another is named — or
 * adding this iPhone to the open Deployment.
 */
export type ComputerSettingsDestination =
  | { readonly deploymentId?: string; readonly kind: "computer"; readonly machineId: string }
  | { readonly kind: "add-iphone" };

/**
 * This iPhone, which can lend its own Calendar, Contacts and Reminders. Null
 * on a phone that cannot, which then has no row of its own.
 */
export interface ThisIphoneSettings {
  /** Requests waiting for an answer on this iPhone. */
  readonly approvals: number;
  /** Whether the open Deployment's Host can take an iPhone. */
  readonly available: boolean;
  readonly deploymentName: string;
  readonly deviceName: string;
  /** The Deployment this iPhone is added, or being added, to. */
  readonly heldBy: {
    readonly deploymentId: string;
    readonly deploymentName: string;
    readonly enrollmentId: string | null;
    readonly name: string;
    readonly runnerId: string;
    readonly state: "enrolled" | "pending";
  } | null;
  /** The open Deployment's Host removed this iPhone since it was last added. */
  readonly removed: boolean;
  readonly selectedDeploymentId: string;
}

const computerSymbols: Readonly<Record<ComputerGlyph, ComputerSymbol>> = {
  compact: "macmini",
  computer: "desktopcomputer",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  phone: "smartphone",
  server: "server.rack",
};

/**
 * The open Opensteer's computers in the words the Computers page uses on
 * every other device: where it runs first, then each computer with what it
 * does for agents and whether it is there.
 */
export function computersSettingsRows(input: {
  readonly apps: ComputerAppsData | null;
  readonly cloud: boolean;
  readonly deploymentKind: DeploymentKind | null;
  readonly deploymentName: string;
  readonly here?: ThisIphoneSettings | null;
  readonly hostConnected: boolean;
  readonly machines: readonly MachineSummary[];
  readonly publicOrigin: string | null;
}): readonly ComputerSettingsRow[] {
  const here = input.here ?? null;
  const heldHere =
    here?.heldBy?.deploymentId === here?.selectedDeploymentId ? (here?.heldBy ?? null) : null;
  // This iPhone is its own row, after where Opensteer runs: never again as a
  // computer, and never as the code its own add is still using.
  const machines = input.machines.filter(
    ({ id }) => heldHere === null || (id !== heldHere.runnerId && id !== heldHere.enrollmentId),
  );
  const overview = computersOverview({ ...input, hereId: null, machines });
  const home = overview.home;
  const homeStatus =
    home.kind === "mac"
      ? home.machine
        ? computerStatus(home.machine).label
        : "Starting"
      : input.hostConnected
        ? "Online"
        : "Offline";
  const rows: ComputerSettingsRow[] = [
    {
      detail: `Your Opensteer runs here · ${homeStatus}`,
      key: "home",
      opens:
        home.kind === "mac" && home.machine
          ? { kind: "computer", machineId: home.machine.id }
          : null,
      name:
        home.kind === "cloud"
          ? "Opensteer Cloud"
          : home.kind === "server"
            ? home.address
            : home.name,
      symbol:
        home.kind === "cloud"
          ? "cloud"
          : home.kind === "server"
            ? "server.rack"
            : home.machine
              ? computerSymbols[computerGlyph(home.machine)]
              : "desktopcomputer",
    },
  ];
  if (here !== null) rows.push(thisIphoneRow(here, heldHere, input));
  for (const machine of overview.groups.flatMap((group) => group.machines)) {
    rows.push({
      detail: computerSettingsDetail(machine, input),
      key: machine.id,
      opens: { kind: "computer", machineId: machine.id },
      name: machine.name,
      symbol: computerSymbols[computerGlyph(machine)],
    });
  }
  return rows;
}

/** What a computer does for agents and whether it is there, in the Computers page's words. */
function computerSettingsDetail(
  machine: MachineSummary,
  input: { readonly apps: ComputerAppsData | null; readonly hostConnected: boolean },
): string {
  const uses = computerUses(machine, input.apps);
  const role = computerRole(machine, uses, input.apps !== null);
  return [
    machine.ownerName,
    role ? computerRoleLabel[role] : null,
    computerUseNow(machine, input.hostConnected) ?? computerStatus(machine).label,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** "You're here": this iPhone, added here, added elsewhere, or not yet added. */
function thisIphoneRow(
  here: ThisIphoneSettings,
  heldHere: ThisIphoneSettings["heldBy"],
  input: {
    readonly apps: ComputerAppsData | null;
    readonly hostConnected: boolean;
    readonly machines: readonly MachineSummary[];
  },
): ComputerSettingsRow {
  const opensteer = `Opensteer on ${here.deploymentName}`;
  const held = here.heldBy;
  if (held !== null && held.deploymentId !== here.selectedDeploymentId) {
    const machineId = held.state === "pending" ? held.enrollmentId : held.runnerId;
    return {
      detail: `You're here · ${held.state === "pending" ? "Being added" : "Added"} to ${held.deploymentName}`,
      key: "this-iphone",
      name: held.name,
      opens:
        machineId === null
          ? null
          : { deploymentId: held.deploymentId, kind: "computer", machineId },
      symbol: "smartphone",
    };
  }
  if (heldHere?.state === "enrolled") {
    const machine = input.machines.find(({ id }) => id === heldHere.runnerId) ?? null;
    return {
      detail:
        here.approvals > 0
          ? `You're here · ${here.approvals} waiting for you`
          : machine === null
            ? "You're here"
            : `You're here · ${computerSettingsDetail(machine, input)}`,
      key: heldHere.runnerId,
      name: machine?.name ?? heldHere.name,
      opens: { kind: "computer", machineId: heldHere.runnerId },
      symbol: "smartphone",
    };
  }
  return here.available
    ? {
        detail: here.removed
          ? `You're here · Removed from ${opensteer}`
          : "You're here · Not added",
        key: "this-iphone",
        name: here.deviceName,
        opens: { kind: "add-iphone" },
        symbol: "smartphone",
      }
    : {
        detail: `You're here · Update ${opensteer} to add this iPhone`,
        key: "this-iphone",
        name: here.deviceName,
        opens: null,
        symbol: "smartphone",
      };
}

/** Registration needs the Account credential, so it must be revoked first. */
export async function signOutAccountInOrder(
  revokeNotificationRegistration: () => Promise<void>,
  revokeAccountCredential: () => Promise<void>,
): Promise<void> {
  await revokeNotificationRegistration();
  await revokeAccountCredential();
}
