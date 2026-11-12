import type { BrowserAccessSuggestion, RequestResponse } from "@opensteer/core";
import type { Request } from "@opensteer/core";
import { profileHomeChoice, type ProfileHomeChoice } from "./browser-profile-settings.js";
import type { HostSnapshot } from "./client.js";
import type { HostApiCommandInput } from "@opensteer/protocol";

/**
 * The owner's answer to a `browser.access` Request,
 * shared by every client so the web and the phone ask the same question the
 * same way. The agent's suggestion is advisory: the profile inventory always
 * comes from the Host snapshot, and the owner can choose another profile.
 */
export type BrowserAccessSelection =
  { readonly kind: "existing"; readonly profileId: string } | { readonly kind: "new" };

export function browserAccessResponse(
  selection: BrowserAccessSelection | null,
  name: string,
  home: string | null = null,
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
    value: {
      createProfile: { name: name.trim(), homeRunnerId: home },
      decision: "fulfilled",
    },
  };
}

export function browserProfileHomeCommand(
  command: HostApiCommandInput,
  homes: readonly string[] | undefined,
): HostApiCommandInput {
  const selection = <Profile extends { readonly homeRunnerId?: unknown }>(profile: Profile) => {
    const { homeRunnerId, ...rest } = profile;
    return homes === undefined ? rest : { ...rest, homeRunnerId: homeRunnerId ?? null };
  };
  if (command.type === "browser.profile.create")
    return { ...command, input: selection(command.input) };
  if (command.type !== "request.respond" || command.response.kind !== "external") return command;
  const value = command.response.value;
  const profile = value?.["createProfile"];
  if (
    value?.["decision"] !== "fulfilled" ||
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  )
    return command;
  const { homeRunnerId, ...rest } = profile;
  return {
    ...command,
    response: {
      ...command.response,
      value: {
        ...value,
        createProfile: homes === undefined ? rest : { ...rest, homeRunnerId: homeRunnerId ?? null },
      },
    },
  };
}

/**
 * Where a profile made by approving this Request can live, starting where the
 * Host would put it: the computer the asking agent works on, else the main
 * computer. Null when there is nothing to choose.
 */
export function browserAccessHomeChoice(
  snapshot: Pick<
    HostSnapshot,
    "browserProfileHomes" | "deploymentShape" | "can" | "environments" | "machines" | "threads"
  >,
  hereId: string | null,
  request: Pick<Request, "originatingThreadId">,
): ProfileHomeChoice | null {
  if ((snapshot.browserProfileHomes?.length ?? 0) < 2) return null;
  const environmentId = snapshot.threads.find(
    ({ id }) => id === request.originatingThreadId,
  )?.environmentId;
  const runnerId = snapshot.environments.find(({ id }) => id === environmentId)?.runnerId ?? null;
  return profileHomeChoice(snapshot, hereId, { runnerId });
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

export interface BrowserAccessChoices {
  readonly nameSuggestions: readonly string[];
  readonly profiles: readonly {
    readonly available: boolean;
    readonly id: string;
    readonly name: string;
  }[];
}

export function browserAccessChoices(
  snapshot: Pick<HostSnapshot, "browserProfiles">,
): BrowserAccessChoices {
  const taken = new Set(snapshot.browserProfiles.map(({ name }) => name.trim().toLowerCase()));
  return {
    nameSuggestions: profileNameSuggestions.filter((name) => !taken.has(name.toLowerCase())),
    profiles: snapshot.browserProfiles.map(({ id, name }) => ({ id, name, available: true })),
  };
}
