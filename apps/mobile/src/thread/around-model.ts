import {
  browserSiteLabel,
  conversationSurfaces,
  conversationThreadIds,
  sameConversationSurfaceSource,
  sameTaskFamilyGlance,
  taskFamilyGlance,
  threadRequester,
  requesterLink,
  workerAssignment,
  type ConversationSurfaceSource,
  type HostSnapshot,
  type RequesterLink,
  type FamilyTask,
  type PlaceActivity,
  type SurfaceItem,
  type TabDestination,
  type TaskFamily,
  type TaskFamilyGlance,
} from "@opensteer/client/host";
import { opensteerAppGlyph, surfaceGlyph, type SurfaceGlyph } from "../browser/agent-surface.js";

/**
 * What is around a conversation: the places it and the work it handed out
 * hold open now (`conversationSurfaces`), the apps it made that are open as
 * tabs, the tasks it handed out and the automations anchored to it
 * (`taskFamily`), and, for work someone handed it,
 * the conversation its current Assignment works for. Nothing here invents a
 * relation the Host did not record.
 */

/** One open tab, Mac app, phone or Opensteer App, in words, and exactly what a press opens. */
export interface AroundPlace {
  readonly key: string;
  readonly glyph: SurfaceGlyph;
  readonly title: string;
  /** The page's site, or the Mac an app is on; null for anything else. */
  readonly detail: string | null;
  /** The page's site icon reference, which `useTabIcon` reads once this device has the page bound. */
  readonly iconRef: string | null;
  /** An agent of this conversation acts in it now, as the Host's activity for that tab says. */
  readonly working: boolean;
  readonly destination: TabDestination;
}

/** Who acts in a tab now, by tab ID (`HostClient.placeActivity`). */
export type ActivityOf = (tabId: string) => readonly Pick<PlaceActivity, "threadId">[];

/** Working places first; each group keeps the order its places opened in. */
export function aroundPlaces(
  source: ConversationSurfaceSource,
  threadId: string,
  activity: ActivityOf,
): readonly AroundPlace[] {
  const threads = conversationThreadIds(source, threadId);
  const places = conversationSurfaces(source, threadId).map((item) =>
    aroundPlace(
      item,
      activity(item.key).some((record) => threads.has(record.threadId)),
    ),
  );
  const listed = new Set(places.map(({ key }) => key));
  const apps = [...source.tabs.rows.values()]
    .filter(
      (tab) =>
        tab.kind === "app" &&
        !listed.has(tab.tabId) &&
        tab.openedBy !== "person" &&
        tab.openedBy.taskId === threadId,
    )
    .reverse()
    .map((tab): AroundPlace => ({
      destination: { kind: "tab", tabId: tab.tabId },
      detail: null,
      iconRef: null,
      glyph: opensteerAppGlyph,
      key: tab.tabId,
      title: tab.title,
      working: false,
    }));
  return [
    ...places.filter(({ working }) => working),
    ...places.filter(({ working }) => !working),
    ...apps,
  ];
}

function aroundPlace(item: SurfaceItem, working: boolean): AroundPlace {
  return {
    destination: item.destination,
    detail:
      item.kind === "page"
        ? item.site === null
          ? null
          : browserSiteLabel(`https://${item.site}`) || item.site
        : item.kind === "window"
          ? item.device.name
          : null,
    iconRef: item.icon.kind === "site" ? item.icon.ref : null,
    glyph: surfaceGlyph(item),
    key: item.key,
    title: item.title,
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
        place.iconRef === other.iconRef &&
        place.working === other.working &&
        JSON.stringify(place.destination) === JSON.stringify(other.destination)
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
    ...(family.earlier.length > 0 || family.ended.length > 0 ? (["earlier"] as const) : []),
    ...(family.automations.length > 0 ? (["schedules"] as const) : []),
  ];
}

/**
 * Where the sheet opens: the section the reader asked for, else a task that
 * needs them, else a place an agent works in, else the first section with
 * anything in it.
 */
export function openingSection(
  places: readonly AroundPlace[],
  family: TaskFamily,
  asked: AroundSection | null = null,
): AroundSection | null {
  if (asked !== null) return asked;
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
  return byDay(tasks, (task) => task.finishedAt, now).map((day) => ({
    tasks: day.items,
    title: day.title,
  }));
}

function byDay<T>(
  items: readonly T[],
  ended: (item: T) => string | null,
  now: number,
): { readonly title: string; readonly items: readonly T[] }[] {
  const days: { title: string; items: T[] }[] = [];
  for (const item of items) {
    const at = ended(item);
    const title = at === null ? "Earlier" : dayTitle(Date.parse(at), now);
    const last = days.at(-1);
    if (last?.title === title) last.items.push(item);
    else days.push({ items: [item], title });
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
 * The way back from work someone handed this task. A Thread this reader
 * cannot open is never offered.
 */
export function aroundFrom(
  snapshot: Parameters<typeof threadRequester>[0],
  threadId: string,
): RequesterLink | null {
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
  /** The open places' tab IDs, whose per-tab activity says which are worked in. */
  readonly placeKeys: readonly string[];
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
  activity: ActivityOf,
): (snapshot: HostSnapshot) => AroundGlance | null {
  let held: {
    readonly source: ConversationSurfaceSource;
    readonly tabRows: HostSnapshot["tabs"]["rows"];
    readonly places: readonly AroundPlace[];
    readonly placeKeys: readonly string[];
    readonly placeGlyph: SurfaceGlyph | null;
  } | null = null;
  return (snapshot) => {
    if (
      held === null ||
      held.tabRows !== snapshot.tabs.rows ||
      !sameConversationSurfaceSource(held.source, snapshot)
    ) {
      const places = aroundPlaces(snapshot, threadId, noActivity);
      const glyphs = new Set(places.map(({ glyph }) => glyph));
      held = {
        placeGlyph: glyphs.size === 1 ? places[0]!.glyph : null,
        placeKeys: places.map(({ key }) => key),
        places,
        source: snapshot,
        tabRows: snapshot.tabs.rows,
      };
    }
    // Activity is read fresh each time: it changes without the snapshot doing so.
    const threads = conversationThreadIds(snapshot, threadId);
    const placesWorking = held.places.filter(({ key }) =>
      activity(key).some((record) => threads.has(record.threadId)),
    ).length;
    const family = taskFamilyGlance(snapshot, threadId);
    const from = aroundFrom(snapshot, threadId);
    if (held.places.length === 0 && family === null && from === null) return null;
    return {
      family,
      from,
      placeGlyph: held.placeGlyph,
      placeKeys: held.placeKeys,
      places: held.places.length,
      placesWorking,
    };
  };
}
const noActivity: ActivityOf = () => [];

export function sameAroundGlance(left: AroundGlance | null, right: AroundGlance | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.places === right.places &&
    (left.placeKeys === right.placeKeys || left.placeKeys.join() === right.placeKeys.join()) &&
    left.placesWorking === right.placesWorking &&
    left.placeGlyph === right.placeGlyph &&
    sameTaskFamilyGlance(left.family, right.family) &&
    sameRequesterLink(left.from, right.from)
  );
}

/** What the header control says to a screen reader, part by part in the order it draws them. */
/** Around's parts, in the order the bar shows them. */
export const aroundParts = ["from", "places", "tasks", "schedules"] as const;
export type AroundPart = (typeof aroundParts)[number];

/**
 * Which of the parts present give way, in order, when the bar is short of
 * room for the conversation's name: schedules, then places, which the page
 * beside Around often stands for. Who it works for and its tasks stay,
 * and so does one part at least, so Around is never an empty button. Everything that
 * gives way is still one tap away, in Around.
 */
export function aroundYieldable(present: readonly AroundPart[]): readonly AroundPart[] {
  const order = (["schedules", "places"] as const).filter((part) => present.includes(part));
  return order.length === present.length ? order.slice(0, -1) : order;
}

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
