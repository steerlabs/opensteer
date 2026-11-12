import { computerGlyph, orderDevices, type ComputerGlyph } from "../computers/computers.js";
import type { BrowserIdentityOpenInput, BrowserTabOpenInput, HostSnapshot } from "./client.js";
import type { BrowserIdentityChoice, StartPageProfileChoice } from "./start-page-model.js";

type DeviceSource = Pick<HostSnapshot, "browserProfileHomes" | "machines">;
type BrowsingSource = Pick<HostSnapshot, "browserProfiles" | "browserSessions" | "browserTabs">;

/**
 * Whether the device the reader is at lends a browser in this Deployment now,
 * as the Host reports it: one of its devices, online and offering one.
 */
export function browserDeviceHere(snapshot: DeviceSource, hereId: string | null): boolean {
  return hereId !== null && browserDevices(snapshot).some(({ id }) => id === hereId);
}

/** The devices this person can browse on now, as the Host lists them. */
function browserDevices(snapshot: DeviceSource) {
  return snapshot.machines.filter(
    (machine) =>
      machine.status === "online" &&
      machine.modules.browser?.readiness === "ready" &&
      (snapshot.browserProfileHomes?.includes(machine.id) ?? true),
  );
}

/**
 * An address only the computer's own network reaches: loopback, a private or
 * link-local range, a `.local` name or a bare host name. Opened from a phone it
 * still means the computer an agent wrote it on.
 */
export function linkOnComputerNetwork(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host.startsWith("[")) return privateIpv6(host.slice(1, -1));
  const ipv4 = ipv4Octets(host);
  if (ipv4) return privateIpv4(ipv4);
  return (
    !host.includes(".") ||
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home\.arpa)$/u.test(host)
  );
}

function ipv4Octets(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function privateIpv4([a, b]: readonly number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  );
}

/** `URL` has already expanded and lower-cased the address, and folded IPv4 tails to hex. */
function privateIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return privateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * The profile last browsed on a device, by when its browsers there last
 * changed; ties go to the name, then the id. Null when none of its profiles
 * has been used there.
 */
export function recentProfileOn(snapshot: BrowsingSource, deviceId: string): string | null {
  const homed = new Map(
    snapshot.browserProfiles
      .filter((profile) => profile.homeRunnerId === deviceId)
      .map((profile) => [profile.id, profile]),
  );
  const latest = new Map<string, number>();
  const sessions = [
    ...snapshot.browserSessions,
    ...(snapshot.browserTabs?.groups().ids ?? []).map((id) => snapshot.browserTabs!.group(id)!),
  ];
  for (const session of sessions) {
    if (session.placement.runnerId !== deviceId || session.profileId === null) continue;
    if (!homed.has(session.profileId)) continue;
    const at = Date.parse(session.updatedAt ?? session.createdAt ?? "") || 0;
    latest.set(session.profileId, Math.max(latest.get(session.profileId) ?? -1, at));
  }
  const [chosen] = [...latest].sort(
    ([leftId, left], [rightId, right]) =>
      right - left ||
      homed.get(leftId)!.name.localeCompare(homed.get(rightId)!.name) ||
      (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
  );
  return chosen?.[0] ?? null;
}

/** A new tab on a device: in its most recent profile, else a Guest there. */
export function browsingOn(snapshot: BrowsingSource, deviceId: string): BrowserTabOpenInput {
  const profileId = recentProfileOn(snapshot, deviceId);
  return profileId === null
    ? { identity: { kind: "guest" }, placement: { kind: "runner", runnerId: deviceId } }
    : { identity: { kind: "profile", profileId } };
}

/** A device a link can be opened on. */
export interface LinkPlace {
  readonly id: string;
  /** The device the reader is at, which its menu names as the reader's own. */
  readonly here: boolean;
  readonly name: string;
  readonly glyph: ComputerGlyph;
  readonly target: BrowserTabOpenInput;
}

export interface LinkPlaces {
  /** Where a tap opens it; null where links open as they always have. */
  readonly tap: LinkPlace | null;
  /** What holding it offers: here, then the conversation's computer, then the rest by name. */
  readonly hold: readonly LinkPlace[];
}

const noPlaces: LinkPlaces = { tap: null, hold: [] };

/**
 * Where a link in a conversation opens, read from a device that lends a
 * browser: here, unless the address is the computer's own network, which the
 * conversation's computer opens. The Host still decides whether it may.
 */
export function linkPlaces(
  snapshot: DeviceSource & BrowsingSource,
  input: {
    readonly hereId: string | null;
    readonly conversationRunnerId: string | null;
    readonly url: string;
  },
): LinkPlaces {
  const { hereId, conversationRunnerId } = input;
  if (hereId === null || !browserDeviceHere(snapshot, hereId)) return noPlaces;
  const devices = browserDevices(snapshot);
  const ordered = orderDevices(devices, hereId);
  const conversation = ordered.find(({ id }) => id === conversationRunnerId && id !== hereId);
  const hold = [
    ...ordered.filter(({ id }) => id === hereId),
    ...(conversation ? [conversation] : []),
    ...ordered.filter(({ id }) => id !== hereId && id !== conversation?.id),
  ].map((machine): LinkPlace => ({
    id: machine.id,
    here: machine.id === hereId,
    name: machine.name,
    glyph: computerGlyph(machine),
    target: browsingOn(snapshot, machine.id),
  }));
  const tap = linkOnComputerNetwork(input.url)
    ? (hold.find(({ id }) => id === conversation?.id) ?? null)
    : hold[0]!;
  return { tap, hold };
}

/**
 * New tab's profiles in the one device order: those on the device the reader
 * is at, then each other device's by its name, then any with no device yet,
 * then Guest.
 */
export function newTabProfiles(
  snapshot: Pick<HostSnapshot, "browserProfiles" | "machines">,
  profiles: readonly StartPageProfileChoice[],
  hereId: string | null,
): readonly StartPageProfileChoice[] {
  const homeOf = ({ identity }: StartPageProfileChoice): string | null =>
    identity.kind === "profile"
      ? (snapshot.browserProfiles.find(({ id }) => id === identity.profileId)?.homeRunnerId ?? null)
      : null;
  const devices = orderDevices(
    snapshot.machines.filter(({ id }) => profiles.some((profile) => homeOf(profile) === id)),
    hereId,
  ).map(({ id }) => id);
  const rank = (profile: StartPageProfileChoice): number => {
    if (profile.identity.kind === "guest") return devices.length + 1;
    const index = devices.indexOf(homeOf(profile) ?? "");
    return index < 0 ? devices.length : index;
  };
  return [...profiles].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.presentation.name.localeCompare(right.presentation.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
}

/**
 * Where a new tab opens a profile: on its home, which the Host keeps. Guest has
 * none, so it opens on the device the reader is at when that lends a browser;
 * elsewhere the Host places it.
 */
export function newTabTarget(
  snapshot: DeviceSource,
  identity: BrowserIdentityChoice,
  hereId: string | null,
): BrowserIdentityOpenInput {
  return identity.kind === "guest" && hereId !== null && browserDeviceHere(snapshot, hereId)
    ? { identity, placement: { kind: "runner", runnerId: hereId } }
    : { identity };
}

/**
 * A reply link opens as a new tab, except an address only the computer's own
 * network reaches: that keeps the Host's placement, which puts Guest on the
 * computer the agent works on.
 */
export function replyLinkTarget(
  snapshot: DeviceSource,
  identity: BrowserIdentityChoice,
  hereId: string | null,
  url: string,
): BrowserIdentityOpenInput {
  return linkOnComputerNetwork(url) ? { identity } : newTabTarget(snapshot, identity, hereId);
}

/** The computer a conversation's agent works on, or null where the Host has not said. */
export function conversationComputerId(
  snapshot: Pick<HostSnapshot, "environments" | "threads">,
  threadId: string,
): string | null {
  const environmentId = snapshot.threads.find(({ id }) => id === threadId)?.environmentId;
  return snapshot.environments.find(({ id }) => id === environmentId)?.runnerId ?? null;
}
