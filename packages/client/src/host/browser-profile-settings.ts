import type { BrowserProfileSummary, HostSnapshot, WorkspaceSummary } from "./client.js";
import { placeList, type PlaceListSource } from "./places.js";
import { browserIdentity, type PlaceBrowserIdentity } from "./start-page-model.js";

/** One profile as Settings lists it: who may browse as it, and what deleting it closes. */
export interface BrowserProfileSettingsRow {
  readonly profile: BrowserProfileSummary;
  readonly identity: PlaceBrowserIdentity;
  /** The specialists allowed to use it, each with the grant that allows it. */
  readonly specialists: readonly {
    readonly grantId: string;
    readonly workspace: WorkspaceSummary;
  }[];
  /** Its tabs, waiting ones included: deleting the profile closes them. */
  readonly tabs: number;
}

export type BrowserProfileSettingsSource = PlaceListSource &
  Pick<HostSnapshot, "browserProfileGrants" | "workspaces">;

export function browserProfileSettingsRows(
  snapshot: BrowserProfileSettingsSource,
): BrowserProfileSettingsRow[] {
  const places = placeList(snapshot);
  return [...snapshot.browserProfiles]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((profile) => ({
      profile,
      identity: browserIdentity(profile.id, snapshot.browserProfiles),
      specialists: snapshot.browserProfileGrants.flatMap((grant) => {
        const workspace = snapshot.workspaces.find(
          (candidate) => candidate.id === grant.workspaceId && candidate.kind === "specialized",
        );
        return grant.profileId === profile.id && workspace
          ? [{ grantId: grant.id, workspace }]
          : [];
      }),
      tabs: places.filter(
        (place) => place.identity?.kind === "profile" && place.identity.profileId === profile.id,
      ).length,
    }));
}

/** The specialists a profile can be given to, by name. */
export function browserProfileSpecialists(
  snapshot: Pick<HostSnapshot, "workspaces">,
): WorkspaceSummary[] {
  return snapshot.workspaces
    .filter((workspace) => workspace.kind === "specialized")
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Who may browse as a profile: Opensteer always, then each specialist allowed. */
export function browserProfileAccessSummary(row: BrowserProfileSettingsRow): string {
  if (row.specialists.length === 0) return "Opensteer only";
  return spokenList(["Opensteer", ...row.specialists.map(({ workspace }) => workspace.name)]);
}

/** What deleting a profile takes with it, beyond its sign-ins and site data. */
export function browserProfileDeleteConsequence(row: BrowserProfileSettingsRow): string {
  const sentences = ["Its sign-ins and site data are erased from this Opensteer."];
  if (row.specialists.length > 0) {
    const names = row.specialists.map(({ workspace }) => workspace.name);
    sentences.push(`${spokenList(names)} ${names.length === 1 ? "loses" : "lose"} access.`);
  }
  if (row.tabs > 0) {
    sentences.push(
      row.tabs === 1 ? "The tab using it closes." : `The ${row.tabs} tabs using it close.`,
    );
  }
  sentences.push("This can’t be undone.");
  return sentences.join(" ");
}

function spokenList(names: readonly string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
