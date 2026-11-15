import { placeIdentityKey, type PlaceEnteredEventView } from "@opensteer/core";
import {
  computerDisplayAuthorityKey,
  computerDisplayScope,
  computerDisplayStatus,
  computerDisplayTargetKey,
  sharedDisplayStreams,
  type ComputerDisplayTarget,
  type DisplayLease,
} from "../integrations/phone-display-stream.js";
import { browserTabPicture, rememberBrowserLastPicture } from "./browser-last-picture.js";
import type { HostClient } from "./client.js";
import { hostSnapshotStore } from "./host-snapshot-store.js";
import { runPlaceDestination, runPlaceSessionId } from "./run-place.js";
import type { NativeViewerSource } from "./surfaces.js";

export interface RunPlacePicture {
  readonly placeKey: string | null;
  readonly usable: boolean;
  readonly fresh: boolean;
  readonly aspect: number | null;
}

export type RunPlacePictureReport =
  | { readonly kind: "drawn"; readonly width: number; readonly height: number }
  | { readonly kind: "cleared" };

export type RunPlaceDisplay = Pick<
  DisplayLease,
  "getSnapshot" | "subscribe" | "onFrame" | "requestKeyframe" | "viewport" | "release"
>;

export const emptyRunPlacePicture: RunPlacePicture = {
  placeKey: null,
  usable: false,
  fresh: false,
  aspect: null,
};

class PictureOwner {
  readonly listeners = new Set<() => void>();
  picture = emptyRunPlacePicture;
  displayTarget: ComputerDisplayTarget | null = null;
  #runId: string | null = null;
  #holds = 0;
  #entry: PlaceEnteredEventView | null = null;
  #stops: (() => void)[] = [];
  #streamStops: (() => void)[] = [];
  #streamKey: string | null = null;
  #source: NativeViewerSource | null = null;
  #authority: string | null = null;
  #display: DisplayLease | null = null;
  #drawn = false;
  #reconciling = false;
  readonly #decoders = new Set<RunPlaceDisplay>();

  readonly client: HostClient;

  constructor(client: HostClient) {
    this.client = client;
  }

  read(runId?: string | null): RunPlacePicture {
    return runId !== undefined && runId !== this.#runId ? emptyRunPlacePicture : this.picture;
  }

  #set(patch: Partial<RunPlacePicture>): void {
    const next = { ...this.picture, ...patch };
    if (
      next.placeKey === this.picture.placeKey &&
      next.usable === this.picture.usable &&
      next.fresh === this.picture.fresh &&
      next.aspect === this.picture.aspect
    )
      return;
    this.picture = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.listeners) listener();
  }

  retain(runId: string | null): () => void {
    if (this.#holds > 0 && this.#runId !== runId)
      throw new Error("A conversation can hold only one Run picture.");
    if (this.#runId !== runId) {
      this.clear();
      this.#runId = runId;
    }
    if (this.#holds++ === 0) {
      this.#stops = [
        hostSnapshotStore(this.client).subscribe(this.#reconcile),
        this.client.browserTabs.subscribe(this.#reconcile),
        ...(runId === null ? [] : [this.client.subscribeRunPlace(runId, this.#reconcile)]),
      ];
      this.#reconcile();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#holds > 0) return;
      for (const stop of this.#stops.splice(0)) stop();
      this.#stopStream();
      this.#set({ fresh: false });
    };
  }

  clear(): void {
    const reconciling = this.#reconciling;
    this.#reconciling = true;
    try {
      this.#stopStream();
      this.#entry = null;
      this.#source = null;
      this.#authority = null;
      this.#drawn = false;
      this.#set(emptyRunPlacePicture);
    } finally {
      this.#reconciling = reconciling;
    }
  }

  #stopStream(): void {
    this.#streamKey = null;
    for (const stop of this.#streamStops.splice(0)) stop();
    for (const decoder of this.#decoders) decoder.release();
    this.#display?.release();
    this.#display = null;
    if (this.displayTarget !== null) {
      this.displayTarget = null;
      this.#notify();
    }
  }

  readonly #reconcile = (): void => {
    if (this.#reconciling || this.#holds === 0) return;
    this.#reconciling = true;
    try {
      const snapshot = this.client.getSnapshot();
      const entry =
        snapshot.session === "authenticated" && snapshot.user && this.#runId
          ? this.client.runPlace(this.#runId)
          : null;
      const key = entry ? placeIdentityKey(entry.data.place) : null;
      if (key !== this.picture.placeKey) {
        this.#stopStream();
        this.#source = null;
        this.#authority = null;
        this.#drawn = false;
        this.#set({ placeKey: key, usable: false, fresh: false });
      }
      this.#entry = entry;
      if (!entry) return;
      const place = entry.data.place;
      if (place.kind === "browser") {
        const destination = runPlaceDestination(entry, snapshot);
        if (destination?.kind !== "browser") return;
        const { sessionId, tabId } = destination;
        const tab = this.client.browserTabs.sessionTab(sessionId, tabId);
        const awake = tab === undefined || tab.state === "live";
        const streamKey = JSON.stringify([sessionId, tabId, awake]);
        if (streamKey !== this.#streamKey) {
          this.#stopStream();
          this.#streamKey = streamKey;
          const update = () => this.#browserPicture(sessionId, tabId, awake);
          this.#streamStops.push(this.client.subscribeBrowserWatch(sessionId, tabId, update));
          this.#streamStops.push(this.client.browserFrames.subscribe(sessionId, update, tabId));
          if (awake)
            this.#streamStops.push(
              this.client.retainBrowserWatch(sessionId, tabId, {
                captureRegion: true,
                frameWindow: true,
                rasterDemand: true,
              }),
            );
        }
        this.#browserPicture(sessionId, tabId, awake);
        return;
      }
      const sessionId = runPlaceSessionId(entry, snapshot);
      if (sessionId !== null)
        this.#source = {
          kind: "task-session",
          sessionId,
          ...(place.kind === "app" ? { appKey: place.appKey } : {}),
        };
      const authority = computerDisplayAuthorityKey(snapshot, this.#source, place.machineId);
      if (authority !== this.#authority) {
        this.#drawn = false;
        this.#authority = authority;
      }
      const scope = computerDisplayScope(snapshot, this.#source);
      const target = scope && authority && this.#source ? { scope, source: this.#source } : null;
      const streamKey = target ? computerDisplayTargetKey(target) : null;
      if (streamKey !== this.#streamKey) {
        this.#stopStream();
        this.#streamKey = streamKey;
        if (target) {
          this.displayTarget = target;
          this.#display = sharedDisplayStreams(this.client).retain(target);
          this.#streamStops.push(this.#display.subscribe(this.#displayPicture));
          this.#notify();
        }
      }
      this.#displayPicture();
    } finally {
      this.#reconciling = false;
    }
  };

  #browserPicture(sessionId: string, tabId: string, awake: boolean): void {
    const state = this.client.browserWatchState(sessionId, tabId);
    const frame = state.frame;
    if (frame) rememberBrowserLastPicture(this.client.browserWatchFrames, sessionId, tabId, frame);
    const kept =
      !awake || state.status !== "unavailable"
        ? browserTabPicture(this.client, sessionId, tabId)
        : null;
    const width = frame?.header.rasterWidth ?? kept?.width;
    const height = frame?.header.rasterHeight ?? kept?.height;
    this.#set({
      usable: frame !== null || kept !== null,
      fresh: awake && frame !== null && state.status === "live",
      ...(width && height ? { aspect: width / height } : {}),
    });
  }

  readonly #displayPicture = (): void => {
    const snapshot = this.#display?.getSnapshot();
    if (snapshot?.connection === "closed" || this.#authority === null) this.#drawn = false;
    this.#set({
      usable: this.#drawn,
      fresh:
        this.#drawn &&
        snapshot?.connection === "open" &&
        computerDisplayStatus(snapshot, this.#entry?.data.place.kind === "phone").reason === null,
    });
  };

  report(placeKey: string, report: RunPlacePictureReport): void {
    if (
      placeKey !== this.picture.placeKey ||
      this.#entry?.data.place.kind === "browser" ||
      this.#holds === 0 ||
      this.#authority === null ||
      this.#display?.getSnapshot().connection === "closed"
    )
      return;
    if (report.kind === "cleared") this.#drawn = false;
    else {
      if (
        !Number.isFinite(report.width) ||
        !Number.isFinite(report.height) ||
        report.width <= 0 ||
        report.height <= 0
      )
        return;
      this.#drawn = true;
      this.#set({ aspect: report.width / report.height });
    }
    this.#displayPicture();
  }

  attach(placeKey: string): RunPlaceDisplay | null {
    const target = this.displayTarget;
    if (this.#holds === 0 || placeKey !== this.picture.placeKey || target === null) return null;
    const lease = sharedDisplayStreams(this.client).retain(target);
    const decoder: RunPlaceDisplay = {
      getSnapshot: lease.getSnapshot,
      subscribe: lease.subscribe,
      onFrame: lease.onFrame,
      viewport: lease.viewport,
      requestKeyframe: lease.requestKeyframe,
      release: () => {
        this.#decoders.delete(decoder);
        lease.release();
      },
    };
    this.#decoders.add(decoder);
    return decoder;
  }
}

const owners = new WeakMap<HostClient, Map<string, PictureOwner>>();

function ownerFor(client: HostClient, threadId: string): PictureOwner {
  let threads = owners.get(client);
  if (!threads) owners.set(client, (threads = new Map()));
  let owner = threads.get(threadId);
  if (!owner) threads.set(threadId, (owner = new PictureOwner(client)));
  return owner;
}

export function runPlacePicture(
  client: HostClient,
  threadId: string,
  runId?: string | null,
): RunPlacePicture {
  return ownerFor(client, threadId).read(runId);
}

export function subscribeRunPlacePicture(
  client: HostClient,
  threadId: string,
  listener: () => void,
): () => void {
  const owner = ownerFor(client, threadId);
  owner.listeners.add(listener);
  return () => {
    owner.listeners.delete(listener);
  };
}

export function retainRunPlacePicture(
  client: HostClient,
  threadId: string,
  runId: string | null,
): () => void {
  return ownerFor(client, threadId).retain(runId);
}

export function reportRunPlacePicture(
  client: HostClient,
  threadId: string,
  placeKey: string,
  report: RunPlacePictureReport,
): void {
  ownerFor(client, threadId).report(placeKey, report);
}

export function runPlaceDisplayTarget(
  client: HostClient,
  threadId: string,
): ComputerDisplayTarget | null {
  return ownerFor(client, threadId).displayTarget;
}

export function attachRunPlaceDisplay(
  client: HostClient,
  threadId: string,
  placeKey: string,
): RunPlaceDisplay | null {
  return ownerFor(client, threadId).attach(placeKey);
}

export function clearRunPlacePictures(client: HostClient): void {
  for (const owner of owners.get(client)?.values() ?? []) owner.clear();
}
