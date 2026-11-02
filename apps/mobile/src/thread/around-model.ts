import {
  browserSiteLabel,
  conversationSurfaces,
  conversationThreadIds,
  sameConversationSurfaceSource,
  sameTaskFamilyGlance,
  surfaceDestination,
  taskFamilyGlance,
  threadRequester,
  requesterLink,
  workerAssignment,
  type ConversationSurfaceSource,
  type HostSnapshot,
  type RequesterLink,
  type FamilyTask,
  type SurfaceItem,
  type TaskFamily,
  type TaskFamilyGlance,
  type TaskSurfaceDestination,
} from "@opensteer/client/host";
import { actingFor, surfaceGlyph, type SurfaceGlyph } from "../browser/agent-surface.js";
import { sameDestination } from "../browser/surface-route.js";

/**
 * What is around a conversation: the places it and the work it handed out
 * hold open now (`conversationSurfaces`), the tasks it handed out and the
 * automations anchored to it (`taskFamily`), and, for work someone handed it,
 * the conversation its current Assignment works for. Nothing here invents a
 * relation the Host did not record.
 */

/** One open tab, Mac app or phone, in words, and exactly what a press opens. */
export interface AroundPlace {
  readonly key: string;
  readonly glyph: SurfaceGlyph;
  readonly title: string;
  /** The page's site, or the Mac an app is on; null for a phone or a page with no address. */
  readonly detail: string | null;
  /** The page's site icon, while this client has one. */
  readonly favicon: string | null;
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
    favicon: item.kind === "browser" ? item.favicon : null,
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
        place.favicon === other.favicon &&
        place.working === other.working &&
        sameDestination(place.destination, other.destination)
      );
    })
  );
}

/** The sheet's sections, in the order the header button draws their parts. */
export type AroundSection = "places" | "tasks" | "earlier" | "schedules";

/** The sections with something in them: a tile never stands for an empty list. */
export function aroundSections(
  places: readonly AroundPlace[],
  family: TaskFamily,
): readonly AroundSection[] {
  return [
    ...(places.length > 0 ? (["places"] as const) : []),
    ...(family.running.length > 0 ? (["tasks"] as const) : []),
    ...(family.earlier.length > 0 ? (["earlier"] as const) : []),
    ...(family.automations.length > 0 ? (["schedules"] as const) : []),
  ];
}

/**
 * Where the sheet opens: a task that needs the reader, else a place an agent
 * works in, else the first section with anything in it.
 */
export function openingSection(
  places: readonly AroundPlace[],
  family: TaskFamily,
): AroundSection | null {
  if (family.running.some(({ needsYou }) => needsYou)) return "tasks";
  if (places.some(({ working }) => working)) return "places";
  return aroundSections(places, family)[0] ?? null;
}

/** The chosen section while it has anything in it, else the first that does. */
export function shownSection(
  chosen: AroundSection,
  sections: readonly AroundSection[],
): AroundSection | null {
  return sections.includes(chosen) ? chosen : (sections[0] ?? null);
}

/** Finished tasks under the day they finished, newest first, as Messages and Mail group mail. */
export interface EarlierDay {
  readonly title: string;
  readonly tasks: readonly FamilyTask[];
}

export function earlierDays(tasks: readonly FamilyTask[], now: number): readonly EarlierDay[] {
  const days: { title: string; tasks: FamilyTask[] }[] = [];
  for (const task of tasks) {
    const title = task.finishedAt === null ? "Earlier" : dayTitle(Date.parse(task.finishedAt), now);
    const last = days.at(-1);
    if (last?.title === title) last.tasks.push(task);
    else days.push({ tasks: [task], title });
  }
  return days;
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const monthDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" });
const monthDayYear = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function dayTitle(time: number, now: number): string {
  const day = new Date(time);
  const today = new Date(now);
  // Calendar days, not 24-hour spans, so a task done before midnight is yesterday's.
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(time);
  return (day.getFullYear() === today.getFullYear() ? monthDay : monthDayYear).format(time);
}

/**
 * The way back from work someone handed this conversation. Chat works for
 * nobody, and a Thread this reader cannot open is never offered.
 */
export function aroundFrom(
  snapshot: Parameters<typeof threadRequester>[0] & Pick<HostSnapshot, "homeThreadId">,
  threadId: string,
): RequesterLink | null {
  if (snapshot.homeThreadId === threadId) return null;
  const assignment = workerAssignment(snapshot.assignments, threadId);
  if (assignment === null) return threadRequester(snapshot, threadId);
  return assignment.parentThreadId === threadId
    ? null
    : requesterLink(snapshot, assignment.parentThreadId);
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
