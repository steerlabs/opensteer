import { PageOpenUrlSchema } from "@opensteer/core";
import { isAppNavigation } from "@opensteer/shared/appFrame";
import { desktopBridge } from "../../desktop/desktop-bridge.js";

/** How the workspace opens a web page a person followed, the same way it opens a reply's link. */
export type AppLinkOpener = (address: string) => void;

/** Where a page an app asked for goes. */
export interface AppLinkPlaces {
  /** Null where there is no workspace (a settings page, an isolated view). */
  readonly open: AppLinkOpener | null;
}

/**
 * Where a request to open a page came from. `frame`: the bootstrap in that
 * app's frame asked on its private port. `window`: desktop main caught a window
 * an app opened, or a navigation of its frame, naming the document it credits
 * (for a window, the focused frame, which need not be the one that opened it).
 */
export type AppLinkProof =
  | { readonly kind: "frame"; readonly frame: HTMLIFrameElement | null }
  | { readonly kind: "window"; readonly source: string };

export type AppLinkOutcome = "opened" | "ignored";

/** At most one page per this long, however often an app asks while a press lasts. */
const openMs = 700;

let lastOpenedAt = Number.NEGATIVE_INFINITY;

function now(): number {
  return performance.now();
}

/** The frame on this page the request speaks for, while it holds focus. */
function requestingFrame(proof: AppLinkProof): HTMLIFrameElement | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLIFrameElement)) return null;
  if (proof.kind === "frame") return focused === proof.frame ? focused : null;
  return focused.src && isAppNavigation(proof.source, focused.src) ? focused : null;
}

/** The person's own browser, for a page the workspace cannot open. */
function openOutside(url: string): void {
  const bridge = desktopBridge();
  if (bridge) {
    void bridge.openExternalUrl({ url }).catch((reason: unknown) => globalThis.reportError(reason));
    return;
  }
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

/**
 * A web page a person followed out of an app opens where a reply's link does:
 * a tab in the workspace, in the profile the start page would choose, or the
 * person's own browser where there is no workspace. It opens at once, without
 * asking, whenever a press is under way and the app holds focus, which a press
 * in it leaves there. An app asking with no press under way, or while it lacks
 * focus, pressed nothing, and nothing happens; nor does a second page within
 * `openMs`, so one press cannot open a stream of them.
 */
export function openAppLink(
  url: string,
  places: AppLinkPlaces,
  proof: AppLinkProof,
): AppLinkOutcome {
  if (typeof document === "undefined") return "ignored";
  const activation = (globalThis.navigator as Navigator | undefined)?.userActivation;
  if (activation && !activation.isActive) return "ignored";
  if (!requestingFrame(proof)) return "ignored";
  const at = now();
  if (at - lastOpenedAt < openMs) return "ignored";
  lastOpenedAt = at;
  if (places.open && PageOpenUrlSchema.safeParse(url).success) places.open(url);
  else openOutside(url);
  return "opened";
}
