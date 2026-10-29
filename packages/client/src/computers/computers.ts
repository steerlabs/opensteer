import type {
  IntegrationConnectionSummary,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import { formatRelativeTime } from "../host/thread-list-model.js";
import { computerAppRows } from "../integrations/computer-apps.js";
import {
  computerUseView,
  isAndroidPhone,
  isIphone,
  phoneUseView,
} from "../integrations/computer-use.js";

/**
 * The Computers page, as every client reads it.
 *
 * Three questions, always in this order: where this Opensteer runs, which
 * other computers its agents can use, and — for each — what it does for them.
 * The words are fixed here so a phone and a desktop can never describe the
 * same computer two ways.
 */

export type DeploymentKind = "personal" | "server";

/** Where the Deployment runs: the top of the page, never a row. */
export type ComputersHome =
  | {
      readonly kind: "mac";
      /** The Mac the Personal Deployment runs on, once its Runner has connected. */
      readonly machine: MachineSummary | null;
      readonly name: string;
    }
  | { readonly kind: "cloud" }
  | { readonly kind: "server"; readonly address: string };

export type ComputerGroupId = "others" | "shared" | "yours" | "teammates";

export interface ComputerGroup {
  readonly id: ComputerGroupId;
  readonly machines: readonly MachineSummary[];
  readonly title: string;
}

export interface ComputersOverview {
  /** The group a person's own new computer joins, which always shows. */
  readonly addTo: ComputerGroupId;
  readonly groups: readonly ComputerGroup[];
  readonly home: ComputersHome;
  /** The Deployment's own browser and messaging, drawn with the home. */
  readonly services: readonly MachineSummary[];
}

export function computersOverview(input: {
  /** Whether Opensteer Cloud runs this Deployment. */
  readonly cloud: boolean;
  readonly deploymentKind: DeploymentKind | null;
  readonly deploymentName: string;
  /** The machine the reader is sitting at, when a desktop can say so. */
  readonly hereId: string | null;
  readonly machines: readonly MachineSummary[];
  /** The Deployment's canonical origin. */
  readonly publicOrigin: string | null;
}): ComputersOverview {
  const services = input.machines.filter(isServiceMachine);
  const computers = sortComputers(
    input.machines.filter((machine) => !isServiceMachine(machine)),
    input.hereId,
  );
  if (input.deploymentKind === "personal") {
    const home = computers.find((machine) => hostsDeployment(machine, "personal")) ?? null;
    return {
      addTo: "others",
      groups: [
        {
          id: "others",
          machines: computers.filter((machine) => machine !== home),
          title: "Other computers agents can use",
        },
      ],
      home: { kind: "mac", machine: home, name: home?.name ?? input.deploymentName },
      services,
    };
  }
  return {
    addTo: "yours",
    groups: [
      {
        id: "shared",
        machines: computers.filter(({ ownership }) => ownership === "deployment"),
        title: "Shared computers",
      },
      {
        id: "yours",
        machines: computers.filter(({ ownership }) => ownership === "mine"),
        title: "Your computers",
      },
      {
        id: "teammates",
        machines: computers.filter(({ ownership }) => ownership === "other"),
        title: "Teammates’ computers",
      },
    ],
    home: input.cloud
      ? { kind: "cloud" }
      : { kind: "server", address: originAddress(input.publicOrigin) ?? input.deploymentName },
    services,
  };
}

/**
 * Whether this row is one of the Deployment's own services rather than a
 * computer: a machine the Deployment owns that does one job — relay a
 * browser, deliver messages — and is never granted `agents`. Ownership
 * settles it, not the grant, because every computer a person adds carries
 * `messaging` too, for the conversations its own apps can carry.
 */
export function isServiceMachine(machine: MachineSummary): boolean {
  return machine.ownership === "deployment" && !machine.allowedModules.includes("agents");
}

/**
 * The Mac a Personal Deployment runs on. The Deployment owns it rather than a
 * person, and nothing else on a Personal Deployment is Deployment-owned but a
 * service.
 */
export function hostsDeployment(
  machine: MachineSummary,
  deploymentKind: DeploymentKind | null,
): boolean {
  return (
    deploymentKind === "personal" &&
    machine.ownership === "deployment" &&
    !isServiceMachine(machine)
  );
}

/** The computer you are at, then the ones that are there, away, and expected. */
export function sortComputers(
  machines: readonly MachineSummary[],
  hereId: string | null,
): readonly MachineSummary[] {
  const rank = (machine: MachineSummary) => {
    if (hereId !== null && machine.id === hereId) return 0;
    if (machine.status === "online") return 1;
    return machine.status === "offline" ? 2 : 3;
  };
  return [...machines].sort((left, right) => rank(left) - rank(right));
}

/* ------------------------------------------------------------------------- *
 * One computer
 * ------------------------------------------------------------------------- */

/** The picture a computer is drawn with: its own shape, or a plain computer. */
export type ComputerGlyph = "laptop" | "desktop" | "compact" | "server" | "phone" | "computer";

export function computerGlyph(machine: MachineSummary): ComputerGlyph {
  return machine.device?.form ?? "computer";
}

export type ServiceGlyph = "browser" | "messaging";

export function serviceGlyph(machine: MachineSummary): ServiceGlyph {
  return machine.allowedModules.includes("browser") ? "browser" : "messaging";
}

/** What a service does, in the words it is listed by. */
export function serviceLabel(machine: MachineSummary): string {
  return serviceGlyph(machine) === "browser" ? "Web browser" : "Messaging";
}

/**
 * One thing agents can use on a computer, as its row and its page draw it.
 * `screen` is an Android phone's whole screen, the one thing a phone lends.
 */
export type ComputerUse =
  | { readonly definitionId: string; readonly kind: "app"; readonly name: string }
  | { readonly kind: "screen-app"; readonly name: string }
  | { readonly kind: "screen" }
  | { readonly count: number; readonly kind: "folders" }
  | { readonly kind: "commands" };

/** The apps a person connected on a computer, which only its owner is told. */
export interface ComputerAppsData {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
}

/**
 * Everything agents working elsewhere can use on this computer: its apps, the
 * apps they may see and operate, a phone's screen, its folders and its
 * commands. `apps` is null while the owner's app list is still loading.
 */
export function computerUses(
  machine: MachineSummary,
  apps: ComputerAppsData | null,
): readonly ComputerUse[] {
  const uses: ComputerUse[] = [];
  if (apps) {
    for (const row of computerAppRows({ ...apps, machine })) {
      if (row.access === null) continue;
      uses.push({ definitionId: row.definition.id, kind: "app", name: row.definition.name });
    }
    const screen = computerUseView({ ...apps, hostConnected: true, machine });
    for (const app of screen?.apps ?? []) {
      if (!app.blocked) uses.push({ kind: "screen-app", name: app.identity.displayName });
    }
    const phone = phoneUseView({ ...apps, hostConnected: true, machine });
    if (phone?.access) uses.push({ kind: "screen" });
  }
  const policy = machine.access?.policy;
  if (policy && policy.reach !== "nobody") {
    const folders = policy.shares.filter((share) => share.path.trim() !== "").length;
    if (folders > 0) uses.push({ count: folders, kind: "folders" });
    if (policy.commands) uses.push({ kind: "commands" });
  }
  return uses;
}

/** `Messages`, `Messages and Notes`, `Messages, Notes and 2 folders`, `its screen`. */
export function computerUsesPhrase(uses: readonly ComputerUse[]): string {
  const words = uses.map((use) => {
    switch (use.kind) {
      case "app":
      case "screen-app":
        return use.name;
      case "screen":
        return "its screen";
      case "folders":
        return use.count === 1 ? "1 folder" : `${use.count} folders`;
      case "commands":
        return "commands";
    }
  });
  if (words.length <= 1) return words[0] ?? "";
  if (words.length <= 3) return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `${words.slice(0, 2).join(", ")} and ${words.length - 2} more`;
}

/**
 * What a computer does for this Deployment, in the words its row says.
 *
 * Null when there is nothing honest to say: another person's computer whose
 * sharing is theirs, or one whose apps are still loading.
 */
export type ComputerRole = "works" | "uses" | "idle" | "waiting";

export const computerRoleLabel: Readonly<Record<ComputerRole, string>> = {
  idle: "Nothing shared yet",
  uses: "Agents can use it",
  waiting: "Waiting to connect",
  works: "Agents work here",
};

export function computerRole(
  machine: MachineSummary,
  uses: readonly ComputerUse[],
  appsLoaded: boolean,
): ComputerRole | null {
  if (machine.status === "pending") return "waiting";
  if (machine.modules.agents) return "works";
  if (uses.length > 0) return "uses";
  if (machine.ownership === "other" || !appsLoaded) return null;
  return "idle";
}

export type ComputerStatusTone = "online" | "offline" | "waiting";

export interface ComputerStatus {
  readonly label: string;
  readonly tone: ComputerStatusTone;
}

export function computerStatus(machine: MachineSummary, now = new Date()): ComputerStatus {
  if (
    machine.status === "needs-update" ||
    machine.status === "updating" ||
    machine.status === "update-pending"
  )
    return {
      label:
        machine.detail ??
        `Update ${isAndroidPhone(machine) ? "Agent Phone" : "Opensteer"} on ${machine.name}.`,
      tone: "waiting",
    };
  if (machine.status === "online") return { label: "Online", tone: "online" };
  if (machine.status === "pending") {
    const minutes = machine.expiresAt
      ? Math.max(0, Math.ceil((new Date(machine.expiresAt).getTime() - now.getTime()) / 60_000))
      : 0;
    return {
      label: minutes > 0 ? `Code expires in ${minutes} min` : "Code expired",
      tone: "waiting",
    };
  }
  // An iPhone is away whenever Opensteer is closed on it, which is not news.
  if (isIphone(machine)) {
    return {
      label: `Offline · Available while Opensteer is open on ${machine.name}`,
      tone: "offline",
    };
  }
  return {
    label: machine.lastSeenAt
      ? `Offline · seen ${formatRelativeTime(machine.lastSeenAt, now)}`
      : "Offline",
    tone: "offline",
  };
}

/**
 * Where a phone reader chooses what agents can use on a computer it cannot
 * manage from here: a computer's own Opensteer, or the iPhone itself.
 */
export function computerUsesChosenElsewhere(machine: MachineSummary): string {
  return isIphone(machine)
    ? `Choose which apps agents can use on ${machine.name} in Opensteer on that iPhone.`
    : `Choose which apps, folders and commands agents can use on ${machine.name} in Opensteer on a computer.`;
}

/** The hostname people reach a server at, from its canonical origin. */
function originAddress(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}
