import {
  type AgentRoster,
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
import {
  actingFor,
  opensteerAppGlyph,
  surfaceGlyph,
  type SurfaceGlyph,
} from "../browser/agent-surface.js";
import { sameDestination, type OpensteerAppDestination } from "../browser/surface-route.js";
import { aroundAgentsSelector } from "./agent-select.js";

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
  /** The page's site icon, while this client has one. */
  readonly favicon: string | null;
  /** An agent of this conversation acts in it now. */
  readonly working: boolean;
  readonly destination: TaskSurfaceDestination | OpensteerAppDestination;
}

type AroundPlaceSource = ConversationSurfaceSource & Pick<HostSnapshot, "appTabs">;

/** Working places first; each group keeps the order its places opened in. */
export function aroundPlaces(source: AroundPlaceSource, threadId: string): readonly AroundPlace[] {
  const threads = conversationThreadIds(source, threadId);
  const places = conversationSurfaces(source, threadId).map((item) =>
    aroundPlace(item, actingFor(item, threads)),
  );
  const apps = (source.appTabs ?? [])
    .filter((tab) => tab.threadId === threadId)
    .reverse()
    .map((tab): AroundPlace => ({
      destination: { appId: tab.appId, kind: "opensteer-app" },
      detail: null,
      favicon: null,
      glyph: opensteerAppGlyph,
      key: `opensteer-app:${tab.appId}`,
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
export type AroundSection = "places" | "tasks" | "agents" | "earlier" | "schedules";

/** The sections with something in them: a tile never stands for an empty list. */
export function aroundSections(
  places: readonly AroundPlace[],
  family: TaskFamily,
  agents: Pick<AgentRoster, "now" | "earlier">,
): readonly AroundSection[] {
  return [
    ...(places.length > 0 ? (["places"] as const) : []),
    ...(family.running.length > 0 ? (["tasks"] as const) : []),
    ...(agents.now.length + agents.earlier.length > 0 ? (["agents"] as const) : []),
    ...(family.earlier.length > 0 ? (["earlier"] as const) : []),
    ...(family.automations.length > 0 ? (["schedules"] as const) : []),
  ];
}

/**
 * Where the sheet opens: the section the reader asked for, else a task or an
 * agent that needs them, else a place an agent works in, else the first
 * section with anything in it.
 */
export function openingSection(
  places: readonly AroundPlace[],
  family: TaskFamily,
  agents: Pick<AgentRoster, "now" | "earlier">,
  asked: AroundSection | null = null,
): AroundSection | null {
  if (asked !== null) return asked;
  if (family.running.some(({ needsYou }) => needsYou)) return "tasks";
  if (agents.now.some(({ tone }) => tone === "needs-you")) return "agents";
  if (places.some(({ working }) => working)) return "places";
  return aroundSections(places, family, agents)[0] ?? null;
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

/** Settled helpers under the day they ended, newest first, as earlier tasks are. */
export function earlierAgentDays<T extends { readonly endedAt: string | null }>(
  cards: readonly T[],
  now: number,
): readonly { readonly title: string; readonly cards: readonly T[] }[] {
  return byDay(cards, (card) => card.endedAt, now).map((day) => ({
    cards: day.items,
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
  /** The conversation's helpers, live or settled: the roster stays reachable after the pill leaves. */
  readonly agents: NonNullable<AgentRoster["pill"]> | null;
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
    readonly source: AroundPlaceSource;
    readonly places: Pick<AroundGlance, "places" | "placesWorking" | "placeGlyph">;
  } | null = null;
  const aroundAgents = aroundAgentsSelector(threadId);
  return (snapshot) => {
    if (
      held === null ||
      held.source.appTabs !== snapshot.appTabs ||
      !sameConversationSurfaceSource(held.source, snapshot)
    ) {
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
    const roster = aroundAgents(snapshot);
    const total = roster.now.length + roster.earlier.length;
    const agents =
      total === 0 ? null : { live: roster.now.length, needsYou: roster.pill?.needsYou ?? 0, total };
    if (held.places.places === 0 && family === null && agents === null && from === null)
      return null;
    return { ...held.places, agents, family, from };
  };
}

export function sameAroundGlance(left: AroundGlance | null, right: AroundGlance | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.places === right.places &&
    left.placesWorking === right.placesWorking &&
    left.placeGlyph === right.placeGlyph &&
    sameTaskFamilyGlance(left.family, right.family) &&
    left.agents?.live === right.agents?.live &&
    left.agents?.total === right.agents?.total &&
    left.agents?.needsYou === right.agents?.needsYou &&
    sameRequesterLink(left.from, right.from)
  );
}

/** What the header control says to a screen reader, part by part in the order it draws them. */
/** Around's parts, in the order the bar shows them. */
export const aroundParts = ["from", "places", "tasks", "agents", "schedules"] as const;
export type AroundPart = (typeof aroundParts)[number];

/**
 * Which of the parts present give way, in order, when the bar is short of
 * room for the conversation's name: schedules, then places, which the page
 * beside Around often stands for. Who it works for, its tasks and its agents stay,
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
    ...(glance.agents === null
      ? []
      : glance.agents.live === 0
        ? [`${glance.agents.total} earlier ${glance.agents.total === 1 ? "agent" : "agents"}`]
        : [
            `${glance.agents.live} ${glance.agents.live === 1 ? "agent" : "agents"} working` +
              (glance.agents.needsYou > 0
                ? `, ${glance.agents.needsYou} ${glance.agents.needsYou === 1 ? "needs" : "need"} you`
                : ""),
          ]),
    ...(family === null || family.automations === 0
      ? []
      : [`${family.automations} ${family.automations === 1 ? "schedule" : "schedules"}`]),
  ].join("; ");
}
