import type {
  BrowserPlacementSummary,
  BrowserProfileSummary,
  BrowserSessionSummary,
} from "./client.js";

/**
 * The profile identity a page browses as, shared by web, desktop and mobile.
 */
export interface BrowserSessionIdentity {
  /** State is temporary; the session may still be signed in to websites. */
  readonly fresh: boolean;
  readonly label: string;
}

/**
 * A null profile means temporary state, independently of website sign-in.
 */
export function browserSessionIdentity(
  profileId: string | null,
  profiles: readonly Pick<BrowserProfileSummary, "id" | "name">[],
): BrowserSessionIdentity {
  if (profileId === null) return { fresh: true, label: "Guest" };
  return {
    fresh: false,
    label: profiles.find((profile) => profile.id === profileId)?.name ?? "Browser profile",
  };
}

/** The computer a session runs on, or null once that computer has gone away. */
export function browserSessionPlace(
  session: Pick<BrowserSessionSummary, "placement">,
  placements: readonly Pick<BrowserPlacementSummary, "label" | "runnerId">[],
): string | null {
  return (
    placements.find((placement) => placement.runnerId === session.placement.runnerId)?.label ?? null
  );
}

/** A tab's title, falling back to its host while the page has not named itself. */
export function browserTabTitle(tab: { readonly title: string; readonly url: string }): string {
  if (tab.title) return tab.title;
  if (!tab.url || tab.url === "about:blank") return "New tab";
  try {
    return new URL(tab.url).hostname || tab.url;
  } catch {
    return tab.url;
  }
}
