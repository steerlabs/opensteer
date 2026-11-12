import type { DeploymentDisplayKind, IdentityConfig } from "@opensteer/core";
import { passwordsSettingsDescription, passwordsSettingsLabel } from "@opensteer/client/host";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";

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

/* ------------------------------------------------------------------------- *
 * The rail
 * ------------------------------------------------------------------------- */

export type SettingsSectionId =
  | "ai"
  | "messaging"
  | "sign-ins"
  | "account"
  | "ai-engines"
  | "apps"
  | "browser-profiles"
  | "chrome"
  | "computers"
  | "devices"
  | "external-agents"
  | "general"
  | "passwords"
  | "plugins";

export const defaultSettingsSection = "general" as const satisfies SettingsSectionId;

export interface SettingsRailItem {
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
  ai: { id: "ai", label: "AI", description: "Accounts and models" },
  messaging: {
    id: "messaging",
    label: "Messaging",
    description: "Message your agents",
  },
  "sign-ins": {
    id: "sign-ins",
    label: "Sign-ins",
    description: "Browsers and passwords",
  },
  "ai-engines": {
    id: "ai-engines",
    label: "AI services",
    description: "The accounts your agents think with",
  },
  apps: {
    id: "apps",
    label: "Connections",
    description: "Accounts and apps agents can use, and where people message them",
  },
  plugins: {
    id: "plugins",
    label: "Plugins",
    description: "Skills, tools and specialists installed for your agents",
  },
  computers: {
    id: "computers",
    label: "Computers",
    description: "Where your Opensteer runs and the computers its agents can use",
  },
  chrome: {
    id: "chrome",
    label: "Chrome",
    description: "Sign-ins agents can use from your Chrome",
  },
  "browser-profiles": {
    id: "browser-profiles",
    label: "Browser profiles",
    description: "Separate browsers with their own sign-ins, and who may use each",
  },
  passwords: {
    id: "passwords",
    label: passwordsSettingsLabel,
    description: passwordsSettingsDescription,
  },
  devices: {
    id: "devices",
    label: "Devices",
    description: "The browsers and apps you are signed in to this Opensteer from",
  },
  "external-agents": {
    id: "external-agents",
    label: "External agents",
    description: "ChatGPT, Claude and other agents you let use Opensteer",
  },
  account: {
    id: "account",
    label: "Account",
    description: "Your Opensteer sign-in",
  },
  general: {
    id: "general",
    label: "General",
    description: "Where it runs and whether your Account lists it",
  },
};

export function settingsItem(
  id: SettingsSectionId,
  _kind: DeploymentDisplayKind,
): SettingsRailItem {
  return settingsItems[id];
}

export function settingsRail(kind: DeploymentDisplayKind): SettingsRailModel {
  return {
    agents: (["ai", "plugins", "sign-ins"] as const).map((id) => settingsItems[id]),
    devices: settingsItem("devices", kind),
  };
}

/** Route matching, not labels, determines which settings category owns a detail page. */
export function settingsSectionForPath(pathname: string): SettingsSectionId | null {
  const section = pathname.split("/")[2];
  if (!section) return defaultSettingsSection;
  return Object.hasOwn(settingsItems, section) ? (section as SettingsSectionId) : null;
}

/** Where this Opensteer is from here, under its name at the foot of Settings. */
export function settingsPlaceDetail(input: {
  readonly facts: SettingsFacts;
  readonly kind: DeploymentDisplayKind;
  readonly publicOrigin: string | undefined;
}): string {
  if (input.kind === "personal") return input.facts.remote ? "Opened remotely" : "Running here";
  return originHostname(input.publicOrigin) ?? "Server";
}

export function originHostname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
