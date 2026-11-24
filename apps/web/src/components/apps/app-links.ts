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

/**
 * Each app frame's presses, as its bootstrap reported them, and how many have opened a page. One
 * press opens one page, however the app asks for it: on its bootstrap's port, or by a window or a
 * navigation desktop main caught.
 */
const presses = new WeakMap<HTMLIFrameElement, { pressed: number; spent: number }>();

/** A press of the person's in `frame`, as that frame's bootstrap reported it on its private port. */
export function noteAppPress(frame: HTMLIFrameElement | null): void {
  if (!frame) return;
  const count = presses.get(frame);
  if (count) count.pressed += 1;
  else presses.set(frame, { pressed: 1, spent: 0 });
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
 * asking, for a press in that app's frame that no page has opened for yet,
 * while the press is under way and the app holds focus, which a press in it
 * leaves there. Anything else, an app asking on its own, for a press elsewhere
 * or for a press already spent, opens nothing.
 */
export function openAppLink(
  url: string,
  places: AppLinkPlaces,
  proof: AppLinkProof,
): AppLinkOutcome {
  if (typeof document === "undefined") return "ignored";
  const activation = (globalThis.navigator as Navigator | undefined)?.userActivation;
  if (activation && !activation.isActive) return "ignored";
  const frame = requestingFrame(proof);
  const count = frame ? presses.get(frame) : undefined;
  if (!count || count.spent >= count.pressed) return "ignored";
  count.spent = count.pressed;
  if (places.open && PageOpenUrlSchema.safeParse(url).success) places.open(url);
  else openOutside(url);
  return "opened";
}
