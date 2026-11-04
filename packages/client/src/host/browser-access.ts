import type { BrowserAccessSuggestion, RequestResponse } from "@opensteer/core";
import type { HostSnapshot } from "./client.js";

/**
 * The owner's answer to a `browser.access` Request,
 * shared by every client so the web and the phone ask the same question the
 * same way. The agent's suggestion is advisory: the profile inventory always
 * comes from the Host snapshot, and the owner can choose another profile.
 */
export type BrowserAccessSelection =
  { readonly kind: "existing"; readonly profileId: string } | { readonly kind: "new" };

/** No selection declines; declining never takes away access the Workspace already has. */
export function browserAccessResponse(
  selection: BrowserAccessSelection | null,
  name: string,
): RequestResponse {
  if (selection === null) return { kind: "external", value: { decision: "declined" } };
  if (selection.kind === "existing") {
    return {
      kind: "external",
      value: { decision: "fulfilled", profileId: selection.profileId },
    };
  }
  return {
    kind: "external",
    value: { createProfile: { name: name.trim() }, decision: "fulfilled" },
  };
}

export function browserAccessInitialSelection(
  suggestion: BrowserAccessSuggestion,
  profiles: readonly { readonly id: string }[],
): BrowserAccessSelection | null {
  if (suggestion.kind === "existing") {
    return profiles.some(({ id }) => id === suggestion.profileId)
      ? { kind: "existing", profileId: suggestion.profileId }
      : null;
  }
  return suggestion.kind === "new" ? { kind: "new" } : null;
}

/** The name field starts from the agent's advisory new-profile name. */
export function browserAccessInitialName(suggestion: BrowserAccessSuggestion): string {
  return suggestion.kind === "new" ? (suggestion.suggestedName ?? "") : "";
}

/** Whether the selection can be sent: a listed profile, or a named new one. */
export function browserAccessGrantable(
  selection: BrowserAccessSelection | null,
  name: string,
  profiles: readonly { readonly id: string }[],
): boolean {
  if (selection === null) return false;
  if (selection.kind === "existing") {
    return profiles.some((profile) => profile.id === selection.profileId);
  }
  return name.trim().length > 0;
}

/** Starting names for a new profile: one or two plain words, never ones already taken. */
const profileNameSuggestions = ["Personal", "Work", "Finance", "Shopping"] as const;

/**
 * What the owner chooses between, for the Workspace that asked. Main already
 * reaches every owner profile, so only a Project marks the ones it can use.
 */
export interface BrowserAccessChoices {
  readonly main: boolean;
  readonly nameSuggestions: readonly string[];
  readonly profiles: readonly {
    readonly available: boolean;
    readonly id: string;
    readonly name: string;
  }[];
  readonly workspaceName: string;
}

export function browserAccessChoices(
  snapshot: Pick<HostSnapshot, "browserProfileGrants" | "browserProfiles" | "workspaces">,
  targetWorkspaceId: string,
): BrowserAccessChoices {
  const workspace = snapshot.workspaces.find(({ id }) => id === targetWorkspaceId);
  const main = workspace?.kind === "main";
  const granted = new Set(
    snapshot.browserProfileGrants
      .filter((grant) => grant.workspaceId === targetWorkspaceId)
      .map((grant) => grant.profileId),
  );
  const taken = new Set(snapshot.browserProfiles.map(({ name }) => name.trim().toLowerCase()));
  return {
    main,
    nameSuggestions: profileNameSuggestions.filter((name) => !taken.has(name.toLowerCase())),
    profiles: snapshot.browserProfiles.map(({ id, name }) => ({
      available: main || granted.has(id),
      id,
      name,
    })),
    workspaceName: workspace?.name ?? "this Workspace",
  };
}

/** A row's note: only a Project marks profiles it can already use. */
export function browserAccessProfileNote(
  choices: BrowserAccessChoices,
  profile: BrowserAccessChoices["profiles"][number],
): string | null {
  return !choices.main && profile.available
    ? `Already available to ${choices.workspaceName}`
    : null;
}

export function browserAccessGrantLabel(
  selection: BrowserAccessSelection | null,
  choices: BrowserAccessChoices,
): string {
  if (selection?.kind === "new") return choices.main ? "Create profile" : "Create and allow";
  const profile = choices.profiles.find(({ id }) => id === selection?.profileId);
  return profile?.available ? "Use profile" : "Allow full control";
}

export function browserAccessWarning(choices: BrowserAccessChoices): string {
  return choices.main
    ? "Agents in Main can use every browser profile you have, with full control of its signed-in accounts, cookies, and tabs."
    : `Agents in ${choices.workspaceName} will have full control of the selected profile, including every signed-in account, cookie, tab, and site the browser can reach.`;
}
