import type { MachineSummary } from "@opensteer/protocol";
import type { HostSnapshot } from "./client.js";
import { hostDeploymentPolicy } from "./deployment-policy.js";
import {
  computerGlyph,
  deviceElsewhere,
  hostsDeployment,
  orderDevices,
  type ComputerGlyph,
  type DeviceElsewhere,
} from "../computers/computers.js";
import { placeHasAgents, type PlaceItem } from "./places.js";
import { sameIdentity, type PlaceBrowserIdentity } from "./start-page-model.js";

/**
 * Which rows the Tabs list shows: those agents are in, one profile's, one
 * device's, or any mix. It is a view of this screen alone, never stored or
 * shared; the Host knows nothing of it.
 */
export interface TabFilter {
  readonly agents: boolean;
  readonly profile: PlaceBrowserIdentity | null;
  /** A device's machine id. */
  readonly device: string | null;
}

export const allTabs: TabFilter = { agents: false, profile: null, device: null };

export function tabFilterActive(filter: TabFilter): boolean {
  return filter.agents || filter.profile !== null || filter.device !== null;
}

/** A device filter leaves out what runs on none, as Opensteer Apps do; a profile one, what browses as none. */
export function tabMatchesFilter(place: PlaceItem, filter: TabFilter): boolean {
  return (
    (!filter.agents || placeHasAgents(place)) &&
    (!filter.profile ||
      (place.identity !== null && sameIdentity(place.identity, filter.profile))) &&
    (!filter.device || place.device?.machineId === filter.device)
  );
}

/** A device the list can narrow to, with how many rows choosing it would show. */
export interface TabFilterDevice {
  readonly id: string;
  readonly name: string;
  readonly glyph: ComputerGlyph;
  readonly online: boolean;
  /** The device the reader is at. */
  readonly here: boolean;
  readonly count: number;
}

export interface TabDeviceChoice {
  /** Empty while every row runs on one device and none is chosen: there is nothing to narrow. */
  readonly devices: readonly TabFilterDevice[];
  /** The filter as it stands: a device that left the Deployment no longer narrows anything. */
  readonly filter: TabFilter;
}

/**
 * The Deployment's devices the list can narrow to, the reader's home
 * (`tabListHomeId`) first and the rest by name, each counted as choosing it
 * would show given the rest of the filter. A chosen device stays offered while
 * it has no rows, as a chosen profile does, so the way back is always in the
 * menu; one that left the Deployment narrows nothing, though a tab it kept may
 * still list it.
 */
export function tabDeviceChoice(input: {
  readonly places: readonly PlaceItem[];
  readonly machines: readonly MachineSummary[];
  readonly hereId: string | null;
  readonly homeId: string | null;
  readonly filter: TabFilter;
}): TabDeviceChoice {
  const { places, machines, hereId } = input;
  const chosen = input.filter.device;
  const filter =
    chosen === null || machines.some(({ id }) => id === chosen)
      ? input.filter
      : { ...input.filter, device: null };
  const listed = new Set(places.flatMap((place) => place.device?.machineId ?? []));
  const offered = machines.filter(({ id }) => listed.has(id) || id === filter.device);
  if (offered.length < 2 && filter.device === null) return { devices: [], filter };
  const devices = orderDevices(
    offered.map((machine): TabFilterDevice => ({
      id: machine.id,
      name: machine.name,
      glyph: computerGlyph(machine),
      online: machine.status === "online",
      here: machine.id === hereId,
      count: places.filter((place) => tabMatchesFilter(place, { ...filter, device: machine.id }))
        .length,
    })),
    input.homeId,
  );
  return { devices, filter };
}

/** What the filter shows, as a title or a label: "Work tabs on Studio Mac with agents". */
export function tabFilterWords(filter: TabFilter, deviceName: string | null): string {
  return [
    filter.profile ? `${filter.profile.name} tabs` : "Tabs",
    filter.device && deviceName ? `on ${deviceName}` : null,
    filter.agents ? "with agents" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What the list says when the filter leaves no row in it. */
export function tabFilterEmptyWords(filter: TabFilter, deviceName: string | null): string {
  const where = [
    filter.profile ? "in this profile" : null,
    filter.device && deviceName ? `on ${deviceName}` : null,
  ].filter(Boolean);
  return [filter.agents ? "No tasks are using tabs" : "No tabs", ...where].join(" ");
}

/**
 * The device the reader's rows never name: the one they are at, or, at none
 * (a browser, or a phone that is not one of the devices), the computer that
 * runs the Deployment, where most of its tabs live.
 */
export function tabListHomeId(
  snapshot: Pick<HostSnapshot, "deploymentPolicy" | "deploymentShape" | "machines">,
  hereId: string | null,
): string | null {
  if (hereId !== null) return hereId;
  const policy = hostDeploymentPolicy(snapshot) ?? null;
  return snapshot.machines.find((machine) => hostsDeployment(machine, policy))?.id ?? null;
}

/**
 * Every device but the reader's home (`tabListHomeId`), by id, as a row names
 * it. Select it with `sameDevicesElsewhere`, so a label keeps its identity, and
 * its row stays undrawn, until the device's name, shape or presence changes.
 */
export function devicesElsewhere(
  machines: readonly MachineSummary[],
  homeId: string | null,
): ReadonlyMap<string, DeviceElsewhere> {
  return new Map(
    machines.flatMap((machine) => {
      const device = deviceElsewhere(machines, machine.id, homeId);
      return device ? [[machine.id, device] as const] : [];
    }),
  );
}

export function sameDevicesElsewhere(
  a: ReadonlyMap<string, DeviceElsewhere>,
  b: ReadonlyMap<string, DeviceElsewhere>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, device] of a) {
    const other = b.get(id);
    if (
      other?.name !== device.name ||
      other.glyph !== device.glyph ||
      other.online !== device.online
    )
      return false;
  }
  return true;
}

/**
 * The device each listed row names beside its title, by place key. Rows name
 * one only once the list spans two or more devices, since with one there is
 * nothing to tell apart, and never the reader's home. A phone's row is already
 * the phone's name.
 */
export function placeDeviceLabels(
  places: readonly Pick<PlaceItem, "device" | "key" | "kind">[],
  elsewhere: ReadonlyMap<string, DeviceElsewhere>,
): ReadonlyMap<string, DeviceElsewhere> {
  const labels = new Map<string, DeviceElsewhere>();
  if (new Set(places.flatMap((place) => place.device?.machineId ?? [])).size < 2) return labels;
  for (const place of places) {
    if (place.kind === "phone" || !place.device) continue;
    const device = elsewhere.get(place.device.machineId);
    if (device) labels.set(place.key, device);
  }
  return labels;
}
