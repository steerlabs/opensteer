import {
  browserSiteLabel,
  conversationSurfaces,
  conversationThreadIds,
  sameConversationSurfaceSource,
  sameTaskFamilyGlance,
  surfaceDestination,
  taskFamilyGlance,
  threadRequester,
  type ConversationSurfaceSource,
  type HostSnapshot,
  type RequesterLink,
  type SurfaceItem,
  type TaskFamilyGlance,
  type TaskSurfaceDestination,
} from "@opensteer/client/host";
import { actingFor, surfaceGlyph, type SurfaceGlyph } from "../browser/agent-surface.js";
import { sameDestination } from "../browser/surface-route.js";

/**
 * What is around a conversation: the places it and the work it handed out
 * hold open now (`conversationSurfaces`), the tasks it handed out and the
 * automations anchored to it (`taskFamily`), and, for work someone handed it,
 * the conversation it works for (`threadRequester`). Nothing here invents a
 * relation the Host did not record.
 */

/** One open tab, Mac app or phone, in words, and exactly what a press opens. */
export interface AroundPlace {
  readonly key: string;
  readonly glyph: SurfaceGlyph;
  readonly title: string;
  /** The page's site, or the Mac an app is on; null for a phone or a page with no address. */
  readonly detail: string | null;
  /** An agent of this conversation acts in it now. */
  readonly working: boolean;
  readonly destination: TaskSurfaceDestination;
}

/** Working places first; each group keeps the order its places opened in. */
export function aroundPlaces(
  source: ConversationSurfaceSource,
  threadId: string,
): readonly AroundPlace[] {
  const threads = conversationThreadIds(source, threadId);
  const places = conversationSurfaces(source, threadId).map((item) =>
    aroundPlace(item, actingFor(item, threads)),
  );
  return [...places.filter(({ working }) => working), ...places.filter(({ working }) => !working)];
}

function aroundPlace(item: SurfaceItem, working: boolean): AroundPlace {
  return {
    destination: surfaceDestination(item),
    detail:
      item.kind === "browser"
        ? item.site === null
          ? null
          : browserSiteLabel(`https://${item.site}`) || item.site
        : item.kind === "app"
          ? item.machine.name
          : null,
    glyph: surfaceGlyph(item),
    key: item.key,
    title:
      item.kind === "browser"
        ? item.title
        : item.kind === "app"
          ? item.app.displayName
          : item.machine.name,
    working,
  };
}

export function sameAroundPlaces(
  left: readonly AroundPlace[],
  right: readonly AroundPlace[],
): boolean {
  return (
    left.length === right.length &&
    left.every((place, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        place.key === other.key &&
        place.title === other.title &&
        place.detail === other.detail &&
        place.working === other.working &&
        sameDestination(place.destination, other.destination)
      );
    })
  );
}

/**
 * The way back from work someone handed this conversation. Chat works for
 * nobody, and a Thread this reader cannot open is never offered.
 */
export function aroundFrom(
  snapshot: Parameters<typeof threadRequester>[0] & Pick<HostSnapshot, "homeThreadId">,
  threadId: string,
): RequesterLink | null {
  return snapshot.homeThreadId === threadId ? null : threadRequester(snapshot, threadId);
}

export function sameRequesterLink(
  left: RequesterLink | null,
  right: RequesterLink | null,
): boolean {
  return left === right || (left?.threadId === right?.threadId && left?.title === right?.title);
}

/**
 * The header's summary, in counts, marks and the parent's name only: a
 * streamed token changes none of them, so the bar never redraws while a
 * reply is written. Null when nothing is around the conversation.
 */
export interface AroundGlance {
  readonly places: number;
  readonly placesWorking: number;
  /** The symbol every open place shares, or null when they are of more than one kind. */
  readonly placeGlyph: SurfaceGlyph | null;
  readonly family: TaskFamilyGlance | null;
  readonly from: RequesterLink | null;
}

/**
 * A selector for one conversation's glance. Places are recounted only when
 * what they are read from changes, not on every snapshot a stream publishes.
 */
export function aroundGlanceSelector(
  threadId: string,
): (snapshot: HostSnapshot) => AroundGlance | null {
  let held: {
    readonly source: ConversationSurfaceSource;
    readonly places: Pick<AroundGlance, "places" | "placesWorking" | "placeGlyph">;
  } | null = null;
  return (snapshot) => {
    if (held === null || !sameConversationSurfaceSource(held.source, snapshot)) {
      const places = aroundPlaces(snapshot, threadId);
      const glyphs = new Set(places.map(({ glyph }) => glyph));
      held = {
        places: {
          placeGlyph: glyphs.size === 1 ? places[0]!.glyph : null,
          places: places.length,
          placesWorking: places.filter(({ working }) => working).length,
        },
        source: snapshot,
      };
    }
    const family = taskFamilyGlance(snapshot, threadId);
    const from = aroundFrom(snapshot, threadId);
    if (held.places.places === 0 && family === null && from === null) return null;
    return { ...held.places, family, from };
  };
}

export function sameAroundGlance(left: AroundGlance | null, right: AroundGlance | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.places === right.places &&
    left.placesWorking === right.placesWorking &&
    left.placeGlyph === right.placeGlyph &&
    sameTaskFamilyGlance(left.family, right.family) &&
    sameRequesterLink(left.from, right.from)
  );
}

/** What the header control says to a screen reader, part by part in the order it draws them. */
export function aroundLabel(glance: AroundGlance): string {
  const { family } = glance;
  return [
    ...(glance.from === null ? [] : [`From ${glance.from.title}`]),
    ...(glance.places === 0
      ? []
      : [
          `${glance.places} ${glance.places === 1 ? "place" : "places"} open` +
            (glance.placesWorking === 0 ? "" : `, ${glance.placesWorking} working`),
        ]),
    ...(family === null
      ? []
      : family.running > 0
        ? [
            `${family.running} ${family.running === 1 ? "task" : "tasks"} running` +
              (family.needsYou ? ", one needs you" : ""),
          ]
        : family.earlier > 0
          ? [`${family.earlier} earlier ${family.earlier === 1 ? "task" : "tasks"}`]
          : []),
    ...(family === null || family.automations === 0
      ? []
      : [`${family.automations} ${family.automations === 1 ? "schedule" : "schedules"}`]),
  ].join("; ");
}
