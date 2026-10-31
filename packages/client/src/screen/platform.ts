import type { ScreenPresentationReceipt, ScreenSurface } from "@opensteer/core";
import type { PlaceItem } from "../host/places.js";
import { nativeViewerSource } from "../host/surfaces.js";
import type { PreparedPresentation } from "./contract.js";

/**
 * The listed place that is exactly this surface: the same tab, the same task
 * session, or the person's own view at the same generation and window. A
 * similarly named app or a newer view of it is a different surface, so a
 * stale or unlisted one finds nothing.
 */
export function listedScreenSurface(
  places: readonly PlaceItem[],
  surface: ScreenSurface,
): PlaceItem | null {
  return places.find((place) => sameSurface(place, surface)) ?? null;
}

function sameSurface({ destination }: PlaceItem, surface: ScreenSurface): boolean {
  if (destination.kind === "browser" || surface.kind === "browser")
    return (
      destination.kind === "browser" &&
      surface.kind === "browser" &&
      destination.sessionId === surface.sessionId &&
      destination.tabId === surface.tabId
    );
  if (destination.kind !== surface.kind || destination.machineId !== surface.machineId)
    return false;
  if (destination.kind === "app" && surface.kind === "app" && destination.appKey !== surface.appKey)
    return false;
  if (
    destination.kind === "phone" &&
    surface.kind === "phone" &&
    (destination.display ?? "main") !== surface.display
  )
    return false;
  const source = nativeViewerSource(destination);
  if (source.kind === "task-session" || surface.source.kind === "task-session")
    return (
      source.kind === "task-session" &&
      surface.source.kind === "task-session" &&
      source.sessionId === surface.source.sessionId
    );
  return (
    source.viewId === surface.source.viewId &&
    source.generation === surface.source.generation &&
    (!("windowId" in surface.source) ||
      (destination.kind === "app" && destination.windowId === surface.source.windowId))
  );
}

const superseded: ScreenPresentationReceipt = { outcome: "superseded" };

/**
 * One prepared presentation's lifecycle, the same on every platform:
 * `commit` is reached only after the guard and the target's fresh resolution
 * pass synchronously, at most once, and the confirmation always settles —
 * with the platform's answer, the refusal, or `superseded` / `unconfirmed`
 * when it is disposed or aborted first.
 */
export function preparedPresentation(input: {
  readonly signal: AbortSignal;
  /** Re-reads the target and the screen just before the route changes; a receipt refuses. */
  readonly refusal: () => ScreenPresentationReceipt | null;
  /** Changes the route, then answers once the platform confirms it or stops being able to. */
  readonly commit: (signal: AbortSignal) => Promise<ScreenPresentationReceipt>;
}): PreparedPresentation {
  const lifetime = new AbortController();
  let settle!: (receipt: ScreenPresentationReceipt) => void;
  const confirmation = new Promise<ScreenPresentationReceipt>((resolve) => {
    settle = resolve;
  });
  let state: "prepared" | "committed" | ScreenPresentationReceipt = "prepared";
  const end = () => {
    if (state === "prepared") state = superseded;
    // A route already changed but not yet confirmed stays unconfirmed; settling twice is a no-op.
    settle(state === "committed" ? { outcome: "unconfirmed" } : state);
    lifetime.abort();
  };
  if (input.signal.aborted) end();
  else input.signal.addEventListener("abort", end, { once: true });
  const refuse = (receipt: ScreenPresentationReceipt) => {
    state = receipt;
    settle(receipt);
    return receipt;
  };
  return {
    confirmation,
    commitIfCurrent(guard) {
      if (state !== "prepared") return state;
      const refused = guard.check() ?? input.refusal();
      if (refused) return refuse(refused);
      state = "committed";
      let committed: Promise<ScreenPresentationReceipt>;
      try {
        committed = input.commit(lifetime.signal);
      } catch {
        return refuse({ outcome: "unconfirmed" });
      }
      void committed.then(settle, () => settle({ outcome: "unconfirmed" }));
      return "committed";
    },
    dispose() {
      input.signal.removeEventListener("abort", end);
      end();
    },
  };
}
