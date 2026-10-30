import type { DeploymentDisplayKind, IdentityConfig } from "@opensteer/core";
import { passwordsSettingsDescription, passwordsSettingsLabel } from "@opensteer/client/host";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";
import type { IconName } from "../icon.js";

/** Settings copy follows observable access facts so presentation labels cannot select behavior. */

export interface SettingsFacts {
  readonly desktop: boolean;
  readonly onThisComputer: boolean;
  /** An authenticated Personal remote session, or its verified desktop route. */
  readonly remote: boolean;
}

/**
 * What this place is called.
 *
 * A Personal Deployment is named after the computer it runs on — "Mac mini",
 * never "This computer" — because that name is read from the *other* laptop
 * just as often as from the machine itself, and "This computer" is a lie
 * everywhere but one. A browser tab has no Desktop catalog to read, so it
 * falls back to what the Deployment says about itself at its own Door.
 */
export function settingsDeploymentName(input: {
  readonly deployment: DesktopDeploymentSummary | null;
  readonly identityConfig: IdentityConfig | null;
}): string {
  const { deployment, identityConfig } = input;
  if (deployment?.name) return deployment.name;
  if (identityConfig?.deployment.name) return identityConfig.deployment.name;
  return originHostname(identityConfig?.publicOrigin) ?? "Opensteer";
}

/** Where this Opensteer runs, as the title of the first fact about it. */
export function settingsWhereItRuns(input: {
  readonly cloud: boolean;
  readonly facts: SettingsFacts;
  readonly kind: DeploymentDisplayKind;
  readonly name: string;
  readonly publicOrigin: string | undefined;
}): string {
  if (input.kind === "personal") {
    return input.facts.onThisComputer ? "Runs on this computer" : `Runs on ${input.name}`;
  }
  if (input.kind === "development") return "Runs in development";
  if (input.cloud) return "Runs in Opensteer Cloud";
  const host = originHostname(input.publicOrigin);
  return host ? `Runs on ${host}` : "Runs on a server";
}

/** What that means for the reader, in one sentence. */
export function settingsWhatThisIs(input: {
  readonly facts: SettingsFacts;
  readonly kind: DeploymentDisplayKind;
  readonly name: string;
}): string {
  if (input.facts.onThisComputer) {
    return "Agents keep working while this computer is on and awake. Open it from other devices with Remote access.";
  }
  if (input.kind === "personal") {
    return `Opening it here moves nothing: agents, files and sign-ins stay on ${input.name}.`;
  }
  return "Always on, and open from any device you sign in on.";
}

/* ------------------------------------------------------------------------- *
 * The rail
 * ------------------------------------------------------------------------- */

export type SettingsSectionId =
  | "account"
  | "ai-engines"
  | "apps"
  | "browser-profiles"
  | "chrome"
  | "computers"
  | "devices"
  | "general"
  | "passwords";

export const defaultSettingsSection = "ai-engines" as const satisfies SettingsSectionId;

export interface SettingsRailItem {
  readonly icon: IconName;
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly description: string;
}

export interface SettingsRailModel {
  /** Everything agents work with: what they think with, use, and sign in as. */
  readonly agents: readonly SettingsRailItem[];
  /** How you yourself reach this Opensteer. */
  readonly devices: SettingsRailItem;
}

export const settingsItems: Readonly<Record<SettingsSectionId, SettingsRailItem>> = {
  "ai-engines": {
    icon: "bolt",
    id: "ai-engines",
    label: "AI services",
    description: "The accounts your agents think with",
  },
  apps: {
    icon: "puzzle",
    id: "apps",
    label: "Connected apps",
    description: "Apps agents can use, and where people message them",
  },
  computers: {
    icon: "desktop",
    id: "computers",
    label: "Computers",
    description: "Where your Opensteer runs and the computers its agents can use",
  },
  chrome: {
    icon: "key",
    id: "chrome",
    label: "Chrome",
    description: "Sign-ins agents can use from your Chrome",
  },
  "browser-profiles": {
    icon: "browser",
    id: "browser-profiles",
    label: "Browser profiles",
    description: "Separate browsers with their own sign-ins, and who may use each",
  },
  passwords: {
    icon: "shield",
    id: "passwords",
    label: passwordsSettingsLabel,
    description: passwordsSettingsDescription,
  },
  devices: {
    icon: "devices",
    id: "devices",
    label: "Signed-in devices",
    description: "The browsers and apps you are signed in to this Opensteer from",
  },
  account: {
    icon: "user",
    id: "account",
    label: "Your account",
    description: "Your Opensteer sign-in",
  },
  general: {
    icon: "settings",
    id: "general",
    label: "About this Opensteer",
    description: "Where it runs and whether your Account lists it",
  },
};

/**
 * Where you open Opensteer from, named for what a person does there. A server
 * is reachable wherever you are, so its page is the list of devices signed in.
 * A Personal Opensteer is reachable only from its own Mac until you turn remote
 * access on, and that switch is what people come to this page for. Neither is
 * called "devices" alone: next to Computers, that reads as the same thing.
 */
export function settingsItem(id: SettingsSectionId, kind: DeploymentDisplayKind): SettingsRailItem {
  if (id === "devices" && kind === "personal") {
    return {
      icon: "globe",
      id,
      label: "Remote access",
      description: "Open this Opensteer from your phone, a browser or another computer",
    };
  }
  return settingsItems[id];
}

/**
 * The rail reads as two answers: what your agents can use, and how you get to
 * Opensteer yourself. Computers sits in the first and devices in the second,
 * which is the whole difference between them.
 */
export function settingsRail(kind: DeploymentDisplayKind): SettingsRailModel {
  return {
    agents: (
      ["ai-engines", "apps", "computers", "browser-profiles", "chrome", "passwords"] as const
    ).map((id) => settingsItems[id]),
    devices: settingsItem("devices", kind),
  };
}

/** Route matching, not labels, determines which settings category owns a detail page. */
export function settingsSectionForPath(pathname: string): SettingsSectionId | null {
  const section = pathname.split("/")[2];
  if (!section) return defaultSettingsSection;
  return Object.hasOwn(settingsItems, section) ? (section as SettingsSectionId) : null;
}

/**
 * Where this Opensteer is, relative to the reader, for the chip in the corner
 * of Settings: the icon says what kind of place it is — the Mac it runs on,
 * Opensteer Cloud, a server — and the line says where that is from here.
 */
export function settingsPlace(input: {
  readonly cloud: boolean;
  readonly facts: SettingsFacts;
  /** The icon of the Mac a Personal Opensteer runs on, once it has said. */
  readonly homeIcon: IconName | null;
  readonly kind: DeploymentDisplayKind;
  readonly publicOrigin: string | undefined;
}): { readonly detail: string; readonly icon: IconName } {
  if (input.kind === "personal") {
    return {
      detail: input.facts.remote ? "Opened remotely" : "Running here",
      icon: input.homeIcon ?? "desktop",
    };
  }
  if (input.kind === "development") return { detail: "Development", icon: "code" };
  if (input.cloud) return { detail: "Opensteer Cloud", icon: "cloud" };
  return { detail: originHostname(input.publicOrigin) ?? "Server", icon: "server" };
}

export function originHostname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
