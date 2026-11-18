import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserPagePart,
  type BrowserFrameView,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";
import {
  useBrowserViewerSurface,
  useHostSelector,
  usePlaceList,
  useTab,
  useTabsRevision,
} from "@opensteer/client/react";
import {
  PlaceContentPartSchema,
  RunnerIdSchema,
  placeContentLabel,
  type PlaceContentPart,
} from "@opensteer/core";
import { act, failureWords } from "../use-action.js";
import { addComposerPlace, composerDrafts, composerPlaceKey } from "../composer-drafts.js";
import { destinationPlaceKey } from "./navigation.js";
import { placeEnded, samePlaceEndSource } from "./place-succession.js";
import { useOptionalWorkspace } from "./workspace-context.js";

/** A place a message carries: a browser page, a Mac app or a phone. */
export type PlacePart = PlaceContentPart;

export interface ContextChip {
  readonly key: string;
  /** Null while an explicit pick is still being read: Send waits for it, × cancels it. */
  readonly part: PlacePart | null;
  /**
   * The draft picked this place up by itself: it does not make a message on
   * its own, and it leaves the draft when its place ends.
   */
  readonly auto: boolean;
  /**
   * Where the place is shown, so an automatic chip leaves when it ends; null
   * for an app or phone handed back, whose wire part names no view.
   */
  readonly destination: PlaceItem["destination"] | null;
  readonly title: string;
  readonly site: string | null;
  /**
   * The place's own mark. A page's icon is read live while its tab shows that
   * page and remembered after it moves on; a neutral mark until an icon is available.
   */
  readonly icon: PlaceItem["icon"];
  /** The place's newest picture when the chip was made, captured once. */
  readonly thumbnail: string | null;
  /** An explicit pick gone from the catalog since: greyed, still removable, never substituted. */
  readonly gone: boolean;
  /** An explicit pick still being read. */
  readonly pending: boolean;
}

interface FollowedCandidate {
  readonly key: string;
  readonly chip: ContextChip;
}

/**
 * What a draft carries beside its words. An untouched Chat or new-task draft
 * follows the place in the middle — a page, a Mac app or a phone — so a
 * question about "this" names which one, on which computer. Its first change
 * of any kind freezes the choice — the place it had, or nothing if a page's
 * read had not answered yet. A place picked up that way still leaves when it
 * ends — its tab closed or its view gone, from here or anywhere else. Removing
 * the chip is a choice that sticks; `+` and `@` add places explicitly at any
 * time. Sending or discarding starts the next draft.
 * Replies to a task never pick anything up by themselves.
 *
 * Every draft is its own generation: an answer that was asked for one draft —
 * a candidate read, a picture, an error — is dropped once the next one began.
 */
export interface ComposerContext {
  readonly chips: readonly ContextChip[];
  /** Every place `+` and `@` can attach, in the sidebar's order. */
  readonly places: readonly PlaceItem[];
  readonly following: boolean;
  /** An explicit pick is still being read; the message waits for it. */
  readonly pending: boolean;
  /** The first mutation of the draft: words, a paste, a file, a quote, a pick. */
  readonly freeze: () => void;
  readonly remove: (key: string) => void;
  readonly add: (place: PlaceItem) => void;
  /** The next draft begins: nothing asked for the one before can reach it. */
  readonly reset: () => void;
  readonly restore: (parts: readonly PlacePart[]) => void;
  /**
   * A returned message's places come back ahead of what the draft holds now,
   * deduped by place.
   */
  readonly prepend: (parts: readonly PlacePart[]) => void;
  readonly parts: () => readonly PlacePart[];
  readonly error: string | null;
}

export function useComposerContext({
  auto,
  draftKey,
  hostClient,
}: {
  /** Chat and new-task drafts follow the place in front; replies do not. */
  readonly auto: boolean;
  /** The saved draft this context picks up from, read once. */
  readonly draftKey: string | null;
  readonly hostClient: HostClient;
}): ComposerContext {
  const workspace = useOptionalWorkspace();
  const listedPlaces = usePlaceList(hostClient);
  const places = useMemo(() => attachablePlaces(listedPlaces), [listedPlaces]);
  const [frozen, setFrozen] = useState<readonly ContextChip[] | null>(() => {
    const saved = draftKey ? composerDrafts.read(draftKey)?.places : undefined;
    return saved ? saved.map(restoredChip) : auto ? null : [];
  });
  const [followed, setFollowed] = useState<FollowedCandidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  const followedRef = useRef(followed);
  followedRef.current = followed;
  // Pictures already taken of a page, so a chip handed back (a refused or
  // queued message) wears its picture and mark again rather than a bare name.
  const pictures = useRef(new Map<string, string>());
  // A page's icon arrives after the page does, and the Host serves it only
  // while a tab shows that page: each carried page's icon is kept here, by its
  // exact document, for its chip once the tab moves on, closes or hands it back.
  const [pageIcons, setPageIcons] = useState<ReadonlyMap<string, SiteIcon>>(() => new Map());
  // The draft each asynchronous answer was asked for; a later draft never takes it.
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const mounted = useRef(true);
  const currentDraftKey = useRef(draftKey);
  currentDraftKey.current = draftKey;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The place in the middle, while the draft follows it: a page by its exact
  // document, a Mac app or phone by the whole reference it would send, since
  // an app keeps its place while its name or signer changes.
  const selection = workspace?.selection;
  const shownKey = selection?.kind === "place" ? destinationPlaceKey(selection.destination) : null;
  const shown = shownKey ? (places.find((place) => place.key === shownKey) ?? null) : null;
  const target = useHostSelector(
    hostClient,
    () => (shown ? pageTarget(hostClient, shown) : null),
    samePageTarget,
  );
  const documentId =
    useBrowserViewerSurface(hostClient, target?.sessionId, target?.tabId)?.documentId ?? null;
  const candidateKey =
    frozen === null && shown?.availability === "ready"
      ? shown.kind !== "page"
        ? `${shown.key}:${JSON.stringify(nativePart(shown))}`
        : documentId
          ? `${shown.key}:${documentId}`
          : null
      : null;

  const shownRef = useRef(shown);
  shownRef.current = shown;
  const sessionId = target?.sessionId ?? null;
  const tabId = target?.tabId ?? null;
  // A page's title is read after the page itself. A followed page read before
  // its title is read again once the catalog publishes one; a title published
  // during a read starts a new read, so the older read's untitled answer is
  // not the last word. The catalog's raw title is watched, since the list
  // names an untitled page by its site.
  const catalogTitle = useTab(hostClient, tabId)?.title ?? null;
  const titleSeen = useRef<SeenTitle | null>(null);
  const [titled, setTitled] = useState(0);
  useEffect(() => {
    const seen = titleSeen.current;
    const now =
      candidateKey !== null && catalogTitle !== null
        ? { key: `${generation}:${candidateKey}`, title: catalogTitle }
        : null;
    titleSeen.current = now;
    const held = followedRef.current;
    if (readsAgainForTitle(seen, now, held?.key === candidateKey ? held.chip.part : null))
      setTitled((value) => value + 1);
  }, [candidateKey, catalogTitle, generation]);
  useEffect(() => {
    const place = shownRef.current;
    if (candidateKey === null || !place) {
      setFollowed(null);
      return;
    }
    // A Mac app or phone is named by the place itself; only a page is read.
    if (place.kind !== "page") {
      setFollowed({
        chip: { ...chipFor(place, nativePart(place), null), auto: true },
        key: candidateKey,
      });
      return;
    }
    if (sessionId === null || tabId === null) {
      setFollowed(null);
      return;
    }
    let current = true;
    const draft = generationRef.current;
    const stillAsked = () => current && draft === generationRef.current;
    // A new document is a new candidate; an answer for another one is dropped.
    if (followedRef.current?.key !== candidateKey) setFollowed(null);
    void autoPlacePart(hostClient, place)
      .then(async (part) => {
        if (!stillAsked() || frozenRef.current !== null) return;
        if (part?.type !== "browser-page" || `${place.key}:${part.documentId}` !== candidateKey) {
          setFollowed(null);
          return;
        }
        // Read again for its title, the page keeps its picture until a newer one is taken.
        const held = followedRef.current;
        const picture = held?.key === candidateKey ? held.chip.thumbnail : null;
        setFollowed({ chip: { ...chipFor(place, part, picture), auto: true }, key: candidateKey });
        // The picture follows when it is ready; the chip never waits for it.
        const thumbnail = await frameThumbnail(hostClient.browserFrames.get(sessionId, tabId));
        if (!stillAsked() || thumbnail === null) return;
        setFollowed((value) =>
          value?.key === candidateKey ? { ...value, chip: { ...value.chip, thumbnail } } : value,
        );
        withThumbnail(candidateKey, thumbnail);
      })
      .catch(() => {
        if (stillAsked()) setFollowed(null);
      });
    return () => {
      current = false;
    };
    // A new draft asks again, even about the same page.
  }, [candidateKey, generation, hostClient, sessionId, tabId, titled]);

  // A frozen pick that leaves the catalog greys out; nothing takes its place.
  const listed = useMemo(
    () => new Map<string, PlaceItem>(places.map((place) => [place.key, place])),
    [places],
  );
  const placeState = useHostSelector(hostClient, selectSnapshot, samePlaceEndSource);
  // The tab list is one live store: its revision says when a tab came or went.
  const tabsRevision = useTabsRevision(hostClient);
  const chips = useMemo(() => {
    const base = frozen ?? (followed && candidateKey === followed.key ? [followed.chip] : []);
    return standing(base, placeState).map((chip) => {
      const place = listed.get(chip.key) ?? nativeTab(places, chip.part);
      const page = pageKey(chip);
      const gone = !place;
      const icon = chipMark(chip, place, page ? pageIcons.get(page) : undefined);
      return chip.gone === gone && chip.icon === icon ? chip : { ...chip, gone, icon };
    });
  }, [candidateKey, followed, frozen, listed, pageIcons, placeState]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  useEffect(() => {
    const seen = chips.flatMap((chip) => {
      const page = pageKey(chip);
      return page &&
        chip.icon.kind === "site" &&
        chip.icon.ref !== null &&
        pageIcons.get(page)?.ref !== chip.icon.ref
        ? [[page, chip.icon] as const]
        : [];
    });
    if (seen.length > 0) setPageIcons((icons) => new Map([...icons, ...seen]));
  }, [chips, pageIcons]);

  /** A picture taken once, for the chip of that page wherever the draft holds it. */
  const withThumbnail = useCallback((page: string, thumbnail: string) => {
    pictures.current.set(page, thumbnail);
    const held = frozenRef.current;
    if (!held?.some((chip) => pageKey(chip) === page && chip.thumbnail === null)) return;
    const next = held.map((chip) =>
      pageKey(chip) === page && chip.thumbnail === null ? { ...chip, thumbnail } : chip,
    );
    frozenRef.current = next;
    setFrozen(next);
  }, []);

  const freeze = useCallback(() => {
    if (frozenRef.current !== null) return;
    // Typing before the page read answered freezes nothing at all.
    const value = chipsRef.current;
    frozenRef.current = value;
    setFrozen(value);
  }, []);
  const remove = useCallback((key: string) => {
    const next = chipsRef.current.filter((chip) => chip.key !== key);
    frozenRef.current = next;
    setFrozen(next);
  }, []);
  const hold = useCallback((next: readonly ContextChip[]) => {
    frozenRef.current = next;
    setFrozen(next);
  }, []);
  // A proven end is final for the draft: a later snapshot that cannot prove it,
  // such as one offline, never brings the chip back.
  useEffect(() => {
    const held = frozenRef.current;
    if (!held) return;
    const kept = standing(held, placeState);
    if (kept.length < held.length) hold(kept);
  }, [frozen, hold, placeState, tabsRevision]);
  /**
   * An explicit pick freezes the draft at once and stands as a chip while its
   * exact reference is read; the answer replaces that chip only if it is still
   * there, in the same draft.
   */
  const add = useCallback(
    (place: PlaceItem) => {
      setError(null);
      const draft = generationRef.current;
      const waiting: ContextChip = { ...chipFor(place, null, null), pending: true };
      const held = draftKey
        ? composerDrafts
            .reserveEdit(draftKey, composerDrafts.read(draftKey)?.editId)
            .catch(() => null)
        : null;
      hold([
        ...(frozenRef.current ?? chipsRef.current).filter((item) => item.key !== place.key),
        waiting,
      ]);
      const stillWaiting = () =>
        draft === generationRef.current && (frozenRef.current?.includes(waiting) ?? false);
      const stillEditing = () => mounted.current && currentDraftKey.current === draftKey;
      const failed = (cause: unknown) => {
        if (!stillEditing() || !stillWaiting()) return;
        hold((frozenRef.current ?? []).filter((chip) => chip !== waiting));
        setError(failureWords(cause));
      };
      void act(hostClient, { label: "add this", done: "added", happened: "this was added" }, () =>
        placePart(hostClient, place),
      )
        .then(async (part) => {
          if (draftKey && held) {
            const editId = await held;
            if (editId === null) {
              failed(null);
              return;
            }
            if (!stillWaiting()) return;
            const saved = await composerDrafts.transaction((store) => {
              if (!stillWaiting()) return false;
              if (!stillEditing())
                return store.handBack(draftKey, { edit: (text) => text, places: [part] }, editId);
              const places = (frozenRef.current ?? []).flatMap((chip) =>
                chip.part ? [chip.part] : [],
              );
              return store.update(draftKey, { places: addComposerPlace(places, part) }, editId);
            });
            if (!saved) {
              failed(null);
              return;
            }
          }
          if (!stillEditing() || !stillWaiting()) return;
          const chip = chipFor(place, part, null);
          hold((frozenRef.current ?? []).map((item) => (item === waiting ? chip : item)));
          const page = pageKey(chip);
          if (page === null || part.type !== "browser-page") return;
          const thumbnail = await frameThumbnail(
            hostClient.browserFrames.get(part.sessionId, part.tabId) ??
              hostClient.browserWatchFrame(part.sessionId, part.tabId),
          );
          if (thumbnail !== null && stillEditing() && draft === generationRef.current)
            withThumbnail(page, thumbnail);
        })
        .catch(failed);
    },
    [draftKey, hold, hostClient, withThumbnail],
  );
  const reset = useCallback(() => {
    generationRef.current += 1;
    setGeneration(generationRef.current);
    const next = auto ? null : [];
    frozenRef.current = next;
    setFrozen(next);
    setFollowed(null);
    setError(null);
  }, [auto]);
  const handedBack = useCallback((part: PlacePart): ContextChip => {
    const chip = restoredChip(part);
    const page = pageKey(chip);
    return { ...chip, thumbnail: (page && pictures.current.get(page)) ?? null };
  }, []);
  const restore = useCallback(
    (parts: readonly PlacePart[]) => hold(parts.map((part) => handedBack(part))),
    [handedBack, hold],
  );
  const prepend = useCallback(
    (parts: readonly PlacePart[]) => {
      const held = frozenRef.current ?? chipsRef.current;
      // A place the newer draft picked explicitly stays that pick, in the returned place.
      const picked = new Map(
        held.flatMap((chip) => (chip.auto ? [] : [[chip.key, chip] as const])),
      );
      const returned = parts.map((part) => {
        const chip = handedBack(part);
        return chip.auto ? (picked.get(chip.key) ?? chip) : chip;
      });
      const keys = new Set(returned.map((chip) => chip.key));
      hold([...returned, ...held.filter((chip) => !keys.has(chip.key))]);
    },
    [handedBack, hold],
  );
  // Read at the press that sends: a choice made a moment earlier counts.
  const parts = useCallback(
    () =>
      standing(frozenRef.current ?? chipsRef.current, hostClient.getSnapshot()).flatMap((chip) =>
        chip.part ? [chip.part] : [],
      ),
    [hostClient],
  );
  const pending = chips.some((chip) => chip.pending);

  return useMemo(
    () => ({
      add,
      chips,
      error,
      following: frozen === null,
      freeze,
      parts,
      pending,
      places,
      remove,
      reset,
      restore,
      prepend,
    }),
    [add, chips, error, freeze, frozen, parts, pending, places, remove, reset, restore, prepend],
  );
}

/** What a draft can name: a published app has no place reference an agent could read. */
export function attachablePlaces(places: readonly PlaceItem[]): readonly PlaceItem[] {
  return places.filter((place) => place.kind !== "app");
}

/** The page session this device's view of a page tab is bound to, once it has been shown here. */
function pageTarget(
  hostClient: HostClient,
  place: PlaceItem,
): { readonly sessionId: string; readonly tabId: string } | null {
  if (place.kind !== "page") return null;
  const viewer = hostClient.tabViewer(place.key);
  return viewer?.kind === "page" ? { sessionId: viewer.sessionId, tabId: place.key } : null;
}
async function boundPage(
  hostClient: HostClient,
  place: PlaceItem,
): Promise<{ readonly sessionId: string; readonly tabId: string }> {
  const viewer = await hostClient.activateTab(place.tab.tabId);
  if (viewer.kind !== "page") throw new Error("This page is unavailable.");
  return { sessionId: viewer.sessionId, tabId: place.key };
}
function samePageTarget(
  left: { readonly sessionId: string; readonly tabId: string } | null,
  right: { readonly sessionId: string; readonly tabId: string } | null,
): boolean {
  return left?.sessionId === right?.sessionId && left?.tabId === right?.tabId;
}

/** The listed window or phone tab a handed-back native part names, if any. */
function nativeTab(places: readonly PlaceItem[], part: PlacePart | null): PlaceItem | undefined {
  if (!part || part.type === "browser-page") return undefined;
  return places.find(
    (place) =>
      place.device.machineId === part.machineId &&
      (part.type === "phone"
        ? place.kind === "phone"
        : place.kind === "window" &&
          place.tab.bundleId?.toLowerCase() === part.app.bundleId.toLowerCase()),
  );
}

/** The shown place's automatic composer reference, read at the time it is asked for. */
export async function autoPlacePart(
  hostClient: HostClient,
  place: PlaceItem | null,
): Promise<PlacePart | null> {
  if (place?.availability !== "ready" || place.kind === "app") return null;
  if (place.kind !== "page") return nativePart(place);
  const target = pageTarget(hostClient, place);
  if (!target) return null;
  const candidate = await hostClient.readBrowserContextCandidate(target.sessionId, target.tabId);
  if (!/^https?:\/\//iu.test(candidate.url)) return null;
  return browserPagePart({ auto: true, ...candidate });
}

/** A part built here is still parsed by the one place schema the Host reads. */
function parsePlacePart(value: unknown): PlacePart {
  return PlaceContentPartSchema.parse(value);
}

/**
 * The exact reference a picked place sends. A browser tab is read through the
 * authorized candidate read — its full address and document — never assembled
 * from the origin-only catalog, and never by opening a view of it.
 */
async function placePart(hostClient: HostClient, place: PlaceItem): Promise<PlacePart> {
  if (place.kind === "page") {
    // A page not shown here yet is bound to this device's view first, so it can be read.
    const target = pageTarget(hostClient, place) ?? (await boundPage(hostClient, place));
    const candidate = await hostClient.readBrowserContextCandidate(target.sessionId, target.tabId);
    return browserPagePart({
      auto: false,
      documentId: candidate.documentId,
      sessionId: candidate.sessionId,
      tabId: candidate.tabId,
      title: candidate.title,
      url: candidate.url,
    });
  }
  return nativePart(place);
}

/** A Mac app's or phone's exact reference: the place names it, with its computer. */
function nativePart(place: PlaceItem): PlacePart {
  if (place.kind === "app") throw new Error("App tabs cannot be attached.");
  if (place.kind === "page") throw new Error("A page is read, not named.");
  const machineId = RunnerIdSchema.parse(place.device.machineId);
  if (place.kind === "phone") {
    return parsePlacePart({
      display: "main",
      machineId,
      name: place.title,
      type: "phone",
    });
  }
  if (!place.tab.bundleId) throw new Error("This app is unavailable.");
  return parsePlacePart({
    app: {
      bundleId: place.tab.bundleId,
      displayName: place.tab.appName ?? place.title,
      teamId: null,
    },
    machineId,
    name: place.title,
    type: "computer-app",
  });
}

type SiteIcon = Extract<PlaceItem["icon"], { readonly kind: "site" }>;

const selectSnapshot = (snapshot: HostSnapshot) => snapshot;

/**
 * The held chips a draft shows and sends — one list for both. A place the
 * draft picked up by itself stands until it ends.
 */
function standing(held: readonly ContextChip[], snapshot: HostSnapshot): readonly ContextChip[] {
  return held.filter(
    (chip) => !(chip.auto && chip.destination && placeEnded(snapshot, chip.destination)),
  );
}

/** The exact page a chip carries, by tab and document; null for an app, phone or unread pick. */
function pageKey(chip: ContextChip): string | null {
  return chip.part?.type === "browser-page" && chip.part.documentId
    ? `${chip.key}:${chip.part.documentId}`
    : null;
}

/**
 * The mark a chip wears: its tab's own while that tab still shows the chip's
 * page (any page, until a pick is read), else the icon remembered for that
 * exact page, else the neutral mark its part names.
 */
export function chipMark(
  chip: ContextChip,
  place: PlaceItem | undefined,
  remembered: SiteIcon | undefined,
): PlaceItem["icon"] {
  const showsPage =
    chip.part?.type !== "browser-page" ||
    (place?.kind === "page" && place.tab.url === chip.part.url);
  return place && showsPage ? place.icon : (remembered ?? chip.icon);
}

interface SeenTitle {
  readonly key: string;
  readonly title: string;
}
/**
 * Whether a followed page is read once more because its tab's title was just
 * published: only for the same draft and document, and only while what the
 * draft holds of it is untitled or still being read.
 */
export function readsAgainForTitle(
  seen: SeenTitle | null,
  now: SeenTitle | null,
  held: PlacePart | null,
): boolean {
  if (!now?.title.trim() || seen?.key !== now.key || seen.title === now.title) return false;
  return !(held?.type === "browser-page" && held.title.trim());
}

/** The mark a part names by itself: its app's, its phone's, or a neutral site mark. */
function partMark(part: PlacePart): PlaceItem["icon"] {
  return part.type === "computer-app"
    ? {
        kind: "app",
        bundleId: part.app.bundleId,
        name: part.app.displayName,
        machineId: part.machineId,
      }
    : part.type === "phone"
      ? { kind: "phone" }
      : { kind: "site", ref: null, url: part.url };
}

export function chipFor(
  place: PlaceItem,
  part: PlacePart | null,
  thumbnail: string | null,
): ContextChip {
  return {
    auto: false,
    destination: place.destination,
    gone: false,
    // A read part names its own page; the read may have found a newer one than was picked.
    icon: part ? partMark(part) : place.icon,
    key: place.key,
    part,
    pending: false,
    site: part?.type === "browser-page" ? siteOf(part.url) : place.site,
    thumbnail,
    title: part?.type === "browser-page" ? pageLabel(part) : place.title,
  };
}

/**
 * A read page's own title, or its site until it names itself: never the title
 * of what its tab showed before, and never written into the part it sends.
 */
function pageLabel(part: Extract<PlacePart, { readonly type: "browser-page" }>): string {
  const title = part.title.trim();
  if (title) return title;
  try {
    const { hostname, protocol } = new URL(part.url);
    if ((protocol === "http:" || protocol === "https:") && hostname) return hostname;
  } catch {
    // An address that does not parse names no site.
  }
  return placeContentLabel({ ...part, title: "" });
}

/**
 * A part handed back to the composer — a queued message taken back to edit, a
 * refused or recovered send — kept exactly as it was, automatic or not.
 */
function restoredChip(part: PlacePart): ContextChip {
  const page = part.type === "browser-page" ? part : null;
  return {
    auto: page?.auto === true,
    destination: page ? { kind: "tab", tabId: page.tabId } : null,
    gone: false,
    icon: partMark(part),
    key: composerPlaceKey(part),
    part,
    pending: false,
    site: page ? siteOf(page.url) : null,
    thumbnail: null,
    title: placeContentLabel(part),
  };
}

function siteOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The newest picture of a place, once, as a 44×28 thumbnail (88×56 for crisp screens). */
async function frameThumbnail(frame: BrowserFrameView | null): Promise<string | null> {
  if (!frame || typeof document === "undefined") return null;
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(frame.data)], { type: `image/${frame.header.encoding}` }),
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The picture could not be read."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 88;
    canvas.height = 56;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // Fit to width from the top: the part of a page a person recognises.
    const scale = canvas.width / frame.header.rasterWidth;
    context.drawImage(image, 0, 0, canvas.width, frame.header.rasterHeight * scale);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
