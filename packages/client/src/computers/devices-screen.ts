import { orgWords, type CloudComputerView } from "@opensteer/control-plane-protocol";
import type { AuthSessionSummary } from "@opensteer/core";
import type { DesktopWorkHome, MachineSummary } from "@opensteer/protocol";
import { formatRelativeTime } from "../host/thread-list-model.js";
import { phoneScreenMac, phoneScreenStatus } from "../integrations/phone-screen.js";
import { cloudSuggestionAllowed } from "./cloud-computer.js";
import { cloudWords } from "./cloud-computer-copy.js";
import { computerStatus, hostsDeployment, isServiceMachine } from "./computers.js";
import { deviceWords } from "./devices-copy.js";
import {
  deviceAccessRows,
  deviceStoppedLabel,
  devicesView,
  isDeviceAsleep,
  type DeviceCapability,
} from "./devices.js";

/**
 * What kind of Home this Opensteer lives on. The Home does not send a kind, so it is
 * derived, in this order, from facts the client already holds:
 * - `work` / `cloud`: the Account's Cloud Computer view whose `deploymentId` is this
 *   Deployment's (a work Home is one an organization assigned, or one whose view carries
 *   the organization's work marker);
 * - `server`: otherwise, a Home the Host reports as `exposure: "networked"`;
 * - `this-mac`: a loopback Home whose Device is the one this app runs on;
 * - `mac`: any other loopback Home.
 */
export type HomeKind = "this-mac" | "mac" | "server" | "cloud" | "work";

export interface HomeKindFact {
  readonly kind: HomeKind;
  /** Which fact decided it, for tests and the report; never shown. */
  readonly from: "account" | "home" | "exposure" | "this-device";
  /** The organization of a work Home. */
  readonly organization: string | null;
}

/** The Account's Cloud Computer read, as far as this question needs it. */
export interface HomeAccountFacts {
  readonly computers: readonly CloudComputerView[];
  readonly work: readonly DesktopWorkHome[];
}

export function homeKind(input: {
  readonly exposure: "loopback" | "networked" | undefined;
  /** What the Home's own configuration says it is; absent from older Homes. */
  readonly homeKind?: "mac" | "server" | "cloud-computer" | undefined;
  readonly deploymentId: string | null;
  /** The Device this app runs on hosts the Home. */
  readonly hostedHere: boolean;
  /** Null until the Account was read, or when this app has no Account. */
  readonly account: HomeAccountFacts | null;
}): HomeKindFact {
  if (input.deploymentId !== null && input.account !== null) {
    const id = input.deploymentId;
    const assigned = input.account.work.find(({ computer }) => computer?.deploymentId === id);
    if (assigned)
      return {
        kind: "work",
        from: "account",
        organization: assigned.home.assignment.organizationName,
      };
    const computer = input.account.computers.find((view) => view.deploymentId === id);
    if (computer?.work)
      return { kind: "work", from: "account", organization: computer.work.organizationName };
    if (computer) return { kind: "cloud", from: "account", organization: null };
  }
  // The Home's own word, when it gave one; a work Home is still the Account's to say.
  if (input.homeKind)
    return {
      kind:
        input.homeKind === "cloud-computer"
          ? "cloud"
          : input.homeKind === "server"
            ? "server"
            : input.hostedHere
              ? "this-mac"
              : "mac",
      from: "home",
      organization: null,
    };
  if (input.exposure === "networked")
    return { kind: "server", from: "exposure", organization: null };
  return input.hostedHere
    ? { kind: "this-mac", from: "this-device", organization: null }
    : { kind: "mac", from: "exposure", organization: null };
}

export type DeviceRowTone = "online" | "asleep" | "offline" | "attention" | "waiting";
export type HomeSymbol = "laptop" | "server" | "cloud";

export interface HomeRowView {
  readonly kind: HomeKind;
  readonly machineId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly symbol: HomeSymbol;
  /** "Work · {organization}" on a work Home. */
  readonly badge: string | null;
}

export interface DeviceScreenRow {
  readonly machine: MachineSummary;
  readonly title: string;
  /** Status first, then what is switched on. */
  readonly detail: string;
  readonly tone: DeviceRowTone;
  readonly thisDevice: boolean;
}

export interface DevicesScreen {
  readonly title: string;
  readonly lead: string;
  readonly home: HomeRowView;
  readonly devices: readonly DeviceScreenRow[];
  readonly alsoSignedIn: ReturnType<typeof devicesView>["alsoSignedIn"];
  readonly alsoSignedInCaption: string;
}

const capabilityWords: Readonly<Record<DeviceCapability, string>> = {
  browser: deviceWords("devices.switch.browser"),
  apps: deviceWords("devices.switch.apps"),
  files: deviceWords("devices.switch.files"),
};

/** One Device's row: its status first, then what agents may use on it when it is online. */
export function deviceScreenRow(
  machine: MachineSummary,
  options: { readonly thisDevice: boolean; readonly devicesAvailable: boolean; readonly now: Date },
): DeviceScreenRow {
  const base = { machine, title: machine.name, thisDevice: options.thisDevice };
  if (
    machine.status === "needs-update" ||
    machine.status === "updating" ||
    machine.status === "update-pending"
  )
    return {
      ...base,
      detail: deviceWords("devices.status.needsUpdate", { device: machine.name }),
      tone: "attention",
    };
  // A Stop on the Device itself says more than its connection; its words are the Mac's.
  const stopped = deviceStoppedLabel(machine, options.now);
  if (stopped) return { ...base, detail: stopped, tone: "waiting" };
  const mac = phoneScreenMac(machine);
  const screen = phoneScreenStatus(machine);
  if (mac && screen)
    return screen.tone === "online"
      ? {
          ...base,
          detail: deviceWords("devices.status.screenThrough", { device: mac.name }),
          tone: "online",
        }
      : { ...base, detail: screen.label, tone: screen.tone === "offline" ? "offline" : "waiting" };
  // A phone with its own screen controller says what that controller is doing.
  if (machine.phoneDisplay) {
    const status = computerStatus(machine, options.now);
    return {
      ...base,
      detail: status.label,
      tone: status.tone === "online" ? "online" : status.tone === "offline" ? "offline" : "waiting",
    };
  }
  if (isDeviceAsleep(machine)) {
    const seen = machine.lastSeenAt ?? machine.asleepSince;
    return {
      ...base,
      detail: seen
        ? deviceWords("devices.status.asleep", { time: formatRelativeTime(seen, options.now) })
        : deviceWords("devices.status.asleepNow"),
      tone: "asleep",
    };
  }
  if (machine.status === "online") {
    const on = deviceAccessRows(machine, options.devicesAvailable)
      .filter((row) => row.kind === "fixed" || row.on === true)
      .map((row) => capabilityWords[row.capability]);
    return {
      ...base,
      detail: [deviceWords("devices.status.online"), ...on].join(" · "),
      tone: "online",
    };
  }
  if (machine.status === "offline") {
    const status = computerStatus(machine, options.now);
    return { ...base, detail: status.label, tone: "offline" };
  }
  return { ...base, detail: computerStatus(machine, options.now).label, tone: "waiting" };
}

function homeRow(
  fact: HomeKindFact,
  machine: MachineSummary | null,
  deploymentName: string,
): HomeRowView {
  const name = machine?.name ?? deploymentName;
  const machineId = machine?.id ?? null;
  switch (fact.kind) {
    case "this-mac":
      return {
        kind: fact.kind,
        machineId,
        title: name,
        detail: deviceWords("devices.home.thisMac"),
        symbol: "laptop",
        badge: null,
      };
    case "mac":
      return {
        kind: fact.kind,
        machineId,
        title: name,
        detail: deviceWords("devices.home.mac"),
        symbol: "laptop",
        badge: null,
      };
    case "server":
      return {
        kind: fact.kind,
        machineId,
        title: name,
        detail: deviceWords("devices.home.server"),
        symbol: "server",
        badge: null,
      };
    case "cloud":
      return {
        kind: fact.kind,
        machineId,
        title: cloudWords("cloud.shortTitle"),
        detail: deviceWords("devices.home.cloud"),
        symbol: "cloud",
        badge: null,
      };
    case "work": {
      const organization = fact.organization ?? "";
      return {
        kind: fact.kind,
        machineId,
        title: orgWords("org.work.title", { organization }),
        detail: deviceWords("devices.home.cloud"),
        symbol: "cloud",
        badge: orgWords("org.work.badge", { organization }),
      };
    }
  }
}

function leadHome(fact: HomeKindFact, row: HomeRowView): string {
  if (fact.kind === "cloud") return deviceWords("devices.lead.cloud");
  if (fact.kind === "work")
    return deviceWords("devices.lead.work", { organization: fact.organization ?? "" });
  return row.title;
}

/** The Devices screen: the Home, then every other Device, then who else is signed in. */
export function devicesScreen(input: {
  readonly machines: readonly MachineSummary[];
  readonly sessions: readonly AuthSessionSummary[];
  /** The Device this app runs on, when it is one. */
  readonly hereId: string | null;
  readonly home: HomeKindFact;
  readonly deploymentName: string;
  readonly devicesAvailable: boolean;
  readonly now?: Date;
}): DevicesScreen {
  const now = input.now ?? new Date();
  const view = devicesView({
    machines: input.machines,
    sessions: input.sessions,
    hereId: input.hereId,
  });
  const homeMachine =
    view.devices.find(({ machine }) => machine.kind === "home")?.machine ??
    view.devices.find(({ machine }) => hostsDeployment(machine))?.machine ??
    null;
  const home = homeRow(input.home, homeMachine, input.deploymentName);
  return {
    title: deviceWords("devices.title"),
    lead: deviceWords("devices.lead", { home: leadHome(input.home, home) }),
    home,
    devices: view.devices
      .filter(({ machine }) => machine.id !== homeMachine?.id && !isServiceMachine(machine))
      .map(({ machine, thisDevice }) =>
        deviceScreenRow(machine, { thisDevice, devicesAvailable: input.devicesAvailable, now }),
      ),
    alsoSignedIn: view.alsoSignedIn,
    alsoSignedInCaption: view.alsoSignedInCaption,
  };
}

/* ------------------------------------------------------------------------- *
 * The asleep moment: one quiet line where real work was blocked, and the
 * Cloud Computer offer under it, at most once every two weeks.
 * ------------------------------------------------------------------------- */

/** What this device remembers about the suggestion: one moment, when, and whether dismissed. */
export interface CloudSuggestionMemory {
  readonly shownAt: number;
  readonly moment: string;
  readonly dismissed: boolean;
}

export const cloudSuggestionStorageKey = "opensteer.cloud-suggestion.v1";

export function parseCloudSuggestionMemory(text: string | null): CloudSuggestionMemory | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as CloudSuggestionMemory).shownAt === "number" &&
      typeof (value as CloudSuggestionMemory).moment === "string" &&
      typeof (value as CloudSuggestionMemory).dismissed === "boolean"
    )
      return value as CloudSuggestionMemory;
  } catch {
    return null;
  }
  return null;
}

/**
 * Whether the offer may show for this moment: never off a Mac Home; once shown for a moment
 * it stays with that moment until Not now; another moment waits two weeks from the last.
 */
export function cloudSuggestionVisible(input: {
  readonly homeKind: HomeKind | null;
  readonly memory: CloudSuggestionMemory | null;
  readonly moment: string;
  readonly now: number;
}): boolean {
  if (input.homeKind !== "mac" && input.homeKind !== "this-mac") return false;
  const { memory } = input;
  if (memory === null) return true;
  if (memory.moment === input.moment) return !memory.dismissed;
  return cloudSuggestionAllowed(memory.shownAt, input.now);
}

/** The memory after the offer first shows for a moment; unchanged if it already did. */
export function cloudSuggestionShown(
  memory: CloudSuggestionMemory | null,
  moment: string,
  now: number,
): CloudSuggestionMemory {
  return memory?.moment === moment ? memory : { shownAt: now, moment, dismissed: false };
}

/** The memory after Not now: quiet for two weeks from now. */
export function cloudSuggestionDismissed(moment: string, now: number): CloudSuggestionMemory {
  return { shownAt: now, moment, dismissed: true };
}

export interface CloudSuggestionWords {
  readonly link: string;
  readonly notNow: string;
  readonly notNowDetail: string;
}
export const cloudSuggestionWords: CloudSuggestionWords = {
  link: cloudWords("cloud.asleep.link"),
  notNow: cloudWords("cloud.notNow"),
  notNowDetail: cloudWords("cloud.notNowDetail"),
};

/** The gate's line when a Mac Home can't be reached; null for any other Home. */
export function asleepGateLine(input: {
  readonly macName: string;
  readonly homeKind: HomeKind | null;
}): string | null {
  return input.homeKind === "mac" || input.homeKind === "this-mac"
    ? deviceWords("asleep.gate", { device: input.macName })
    : null;
}

/**
 * A tool call the Home refused because the Device it needed is asleep: the Home's own
 * `computer_asleep` code, never a guess from words. Names the Device the Home's refusal
 * named, or else the one the call said, by its `computerId`.
 */
export function asleepToolFailure(
  tool: {
    readonly state: string;
    readonly output: { readonly text: string } | undefined;
    readonly arguments: unknown;
  },
  machines: readonly Pick<MachineSummary, "id" | "name">[],
): { readonly line: string; readonly device: string | null } | null {
  if (tool.state !== "failed" || !tool.output) return null;
  let code: unknown;
  let named: unknown;
  try {
    const parsed: unknown = JSON.parse(tool.output.text);
    const error =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? (parsed as { error?: { code?: unknown; device?: { name?: unknown } } }).error
        : undefined;
    code = error?.code;
    named = error?.device?.name;
  } catch {
    return null;
  }
  if (code !== "computer_asleep") return null;
  const args = tool.arguments;
  const computerId =
    typeof args === "object" && args !== null && "computerId" in args
      ? (args as { computerId?: unknown }).computerId
      : undefined;
  // The Device the Home named when it refused, else the one the call itself named.
  const device =
    typeof named === "string" && named
      ? named
      : typeof computerId === "string"
        ? (machines.find((machine) => machine.id === computerId)?.name ?? null)
        : null;
  return {
    device,
    line: deviceWords("asleep.activity", { device: device ?? deviceWords("asleep.someDevice") }),
  };
}

/** The Home page's facts for a server Home: its address, its version, who is signed in. */
export function serverHomeFacts(input: {
  readonly publicOrigin: string | null;
  readonly homeMachine: Pick<MachineSummary, "runtimeVersion"> | null;
  /** A personal Home has one person, its owner. */
  readonly personal: boolean;
  /** The signed-in person's relation to the Home, when the Home said it. */
  readonly role?: "owner" | "member" | undefined;
}): {
  readonly address: { readonly label: string; readonly value: string } | null;
  readonly version: { readonly label: string; readonly value: string } | null;
  readonly owner: string | null;
} {
  return {
    address: input.publicOrigin
      ? { label: deviceWords("home.address"), value: input.publicOrigin }
      : null,
    version: input.homeMachine?.runtimeVersion
      ? { label: deviceWords("home.version"), value: input.homeMachine.runtimeVersion }
      : null,
    owner:
      (input.role ?? (input.personal ? "owner" : null)) === "owner"
        ? deviceWords("home.owner")
        : null,
  };
}
