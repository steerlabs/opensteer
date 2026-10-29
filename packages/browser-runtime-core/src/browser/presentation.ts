import type { BrowserSessionId, BrowserSurfaceId } from "@opensteer/protocol/browser";
import type { BrowserPage, PageGeometry } from "./backend.js";
import type { PageSize } from "./surface-ledger.js";

export interface PresentedGeometry {
  readonly geometry: PageGeometry;
  /** The ledger's geometry revision: agent pointers and activity name the one they were measured in. */
  readonly geometryRevision: number;
}

export type PresentedSurfaceEvent =
  { readonly type: "closed" } | ({ readonly type: "geometry" } & PresentedGeometry);

/**
 * One page a process shows natively from its own Browser Runtime. The
 * presentation only places the page: tabs, dialogs, activity and size stay
 * with the ledger, which hears the person's view size through `follow`.
 */
export interface PresentedSurface {
  readonly page: BrowserPage;
  readonly sessionId: BrowserSessionId;
  readonly surfaceId: BrowserSurfaceId;
  /** The size of the person's view of the page, with `viewport.follow` semantics. */
  follow(size: PageSize | (() => PageSize | null)): Promise<void>;
  /** The geometry applied now; null until the page's first geometry is applied. */
  geometry(): PresentedGeometry | null;
  onEvent(listener: (event: PresentedSurfaceEvent) => void): () => void;
  release(): void;
}

/** A Browser Runtime running in the presenting process. Holding a session proves locality only, never authority. */
export interface NativePresentationSource {
  hasSession(sessionId: BrowserSessionId): boolean;
  presentSurface(sessionId: BrowserSessionId, surfaceId: BrowserSurfaceId): PresentedSurface | null;
}
