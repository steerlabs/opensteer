import type { BrowserAccessSuggestion, RequestResponse } from "@opensteer/core";

/**
 * The owner's answer to a `browser.access` or `browser.profile.save` Request,
 * shared by every client so the web and the phone ask the same question the
 * same way. The agent's suggestion is advisory: the profile inventory always
 * comes from the Host snapshot, and the owner can choose another profile.
 */
export type BrowserAccessSelection =
  | { readonly kind: "existing"; readonly profileId: string }
  | { readonly kind: "new" }
  | { readonly kind: "save" };

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
  if (selection.kind === "save") {
    return { kind: "external", value: { decision: "fulfilled", name: name.trim() } };
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

export function browserAccessGrantLabel(alreadyAvailable: boolean): string {
  return alreadyAvailable ? "Use profile" : "Allow full control";
}

export function browserAccessAvailableLabel(workspaceName: string): string {
  return `Already available to ${workspaceName}`;
}

export function browserAccessWarning(workspaceName: string): string {
  return `Agents in ${workspaceName} will have full control of the selected profile, including every signed-in account, cookie, tab, and site the browser can reach.`;
}

export function browserProfileSavePrompt(workspaceName: string): string {
  return `${workspaceName} wants to save this browser’s signed-in state as a new profile.`;
}
