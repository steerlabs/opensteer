import {
  computerGlyph,
  deviceElsewhere,
  hostsDeployment,
  orderDevices,
  type ComputerGlyph,
  type DeviceElsewhere,
} from "../computers/computers.js";
import type { BrowserProfileSummary, HostSnapshot } from "./client.js";
import { placeList, type PlaceListSource } from "./places.js";
import { browserIdentity, type PlaceBrowserIdentity } from "./start-page-model.js";

/** One profile as Settings lists it: who may browse as it, and what deleting it closes. */
export interface BrowserProfileSettingsRow {
  readonly profile: BrowserProfileSummary;
  readonly identity: PlaceBrowserIdentity;
  /** Its tabs, waiting ones included: deleting the profile closes them. */
  readonly tabs: number;
  /** The device it lives on, named only when that is not the one the reader is at. */
  readonly device: DeviceElsewhere | null;
  /** An old profile with no device yet: the first open chooses one. */
  readonly unopened: boolean;
}

export type BrowserProfileSettingsSource = PlaceListSource &
  Pick<HostSnapshot, "browserProfileHomes">;

export function browserProfileSettingsRows(
  snapshot: BrowserProfileSettingsSource,
  hereId: string | null,
): BrowserProfileSettingsRow[] {
  const places = placeList(snapshot);
  return [...snapshot.browserProfiles]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((profile) => ({
      profile,
      identity: browserIdentity(profile.id, snapshot.browserProfiles),
      device: deviceElsewhere(snapshot.machines, profile.homeRunnerId, hereId),
      // An older Host says nothing of homes, so its profiles are not "unopened".
      unopened: profile.homeRunnerId === null && snapshot.browserProfileHomes !== undefined,
      tabs: places.filter(
        (place) => place.identity?.kind === "profile" && place.identity.profileId === profile.id,
      ).length,
    }));
}

/** A device a new profile can live on, as its menu lists it. */
export interface ProfileHomeOption {
  readonly glyph: ComputerGlyph;
  /** The device the reader is at. */
  readonly here: boolean;
  readonly id: string;
  readonly name: string;
}

/** Where a new profile can live, and where it lives unless the person says otherwise. */
export interface ProfileHomeChoice {
  readonly initial: string;
  readonly options: readonly ProfileHomeOption[];
}

/**
 * The devices a new profile can be kept on, in the one device order, or null
 * when there is nothing to choose: one device, or a Host that does not say.
 * It starts on the device the reader is at, else the Deployment's main
 * computer, else the first. One an agent asked for starts where the Host
 * would put it instead: the computer that agent works on, else the main one.
 */
export function profileHomeChoice(
  snapshot: Pick<HostSnapshot, "browserProfileHomes" | "deploymentShape" | "can" | "machines">,
  hereId: string | null,
  asking?: { readonly runnerId: string | null },
): ProfileHomeChoice | null {
  const homes = snapshot.browserProfileHomes ?? [];
  const options = orderDevices(
    snapshot.machines
      .filter(({ id }) => homes.includes(id))
      .map((machine) => ({
        glyph: computerGlyph(machine),
        here: machine.id === hereId,
        id: machine.id,
        name: machine.name,
        main: hostsDeployment(machine),
      })),
    hereId,
  );
  if (options.length < 2) return null;
  const initial =
    (asking
      ? options.find(({ id }) => id === asking.runnerId)
      : options.find(({ here }) => here)) ??
    options.find(({ main }) => main) ??
    options[0]!;
  return {
    initial: initial.id,
    options: options.map(({ glyph, here, id, name }) => ({ glyph, here, id, name })),
  };
}

/** What deleting a profile takes with it, beyond its sign-ins and site data. */
export function browserProfileDeleteConsequence(row: BrowserProfileSettingsRow): string {
  const sentences = ["Its sign-ins and site data are erased from this Opensteer."];
  if (row.tabs > 0) {
    sentences.push(
      row.tabs === 1 ? "The tab using it closes." : `The ${row.tabs} tabs using it close.`,
    );
  }
  sentences.push("This can’t be undone.");
  return sentences.join(" ");
}

export function browserProfileDeletionRows(
  snapshot: Pick<HostSnapshot, "browserProfileDeletions" | "machines">,
): { readonly profileId: string; readonly status: string }[] {
  return (snapshot.browserProfileDeletions ?? []).map((deletion) => {
    const computer =
      snapshot.machines.find((machine) => machine.id === deletion.computerId)?.name ??
      "its computer";
    return {
      profileId: deletion.profileId,
      status:
        deletion.state === "pending-restart"
          ? `Erased after Opensteer restarts on ${computer}`
          : `Will be erased when ${computer} is back online`,
    };
  });
}
