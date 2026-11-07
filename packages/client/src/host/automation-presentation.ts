import type { TriggerOccurrence } from "@opensteer/triggers";
import type { TriggerDetail } from "./client.js";
import cronstrue from "cronstrue";
import type { TriggerSchedule, TriggerSource, TriggerSummary } from "@opensteer/triggers";

/** What an automation is, told by when it runs. */
export type AutomationShape = "once" | "repeating" | "webhook" | "watch";

export function automationShape(source: TriggerSource): AutomationShape {
  if (source.kind === "webhook") return "webhook";
  if (source.kind === "watch") return "watch";
  return source.schedule.kind === "at" ? "once" : "repeating";
}

export const automationGlyph = {
  once: "clock",
  repeating: "repeat",
  webhook: "bolt",
  watch: "eye",
} as const satisfies Record<AutomationShape, string>;

export type AutomationGroup =
  "attention" | "upcoming" | "repeating" | "events" | "paused" | "system";

/** The page's sections, in the order a person reads them. */
export const automationGroups: readonly { readonly id: AutomationGroup; readonly title: string }[] =
  [
    { id: "attention", title: "Needs attention" },
    { id: "upcoming", title: "Coming up" },
    { id: "repeating", title: "Repeating" },
    { id: "events", title: "When something happens" },
    { id: "paused", title: "Paused" },
    { id: "system", title: "Built in" },
  ];

/** What placing an automation reads, so the web's summaries and the phone's items share it. */
export type PlaceableAutomation = Pick<
  TriggerSummary,
  "latestOccurrence" | "name" | "nextFireAt" | "pauseReason" | "source" | "status" | "updatedAt"
> & {
  readonly systemRole?: TriggerSummary["systemRole"];
  readonly waitingReason?: string | null | undefined;
};

export interface AutomationPlacement {
  readonly group: AutomationGroup;
  /** What is wrong, in plain words; set exactly when the group is "attention". */
  readonly problem: string | null;
}

/**
 * Where one automation belongs. Something needs its owner when Opensteer
 * paused it, or when a one-time automation's moment came and went without a
 * successful run — a successful one finishes it and it leaves the list.
 * Opensteer's own memory passes sit apart unless they need attention.
 */
export function placeAutomation(summary: PlaceableAutomation, now: number): AutomationPlacement {
  const shape = automationShape(summary.source);
  if (summary.status === "paused") {
    if (summary.pauseReason) return attention(summary.pauseReason);
    if (shape === "once" && onceAt(summary.source) <= now) {
      return attention("Its time passed while it was paused.");
    }
    return { group: summary.systemRole ? "system" : "paused", problem: null };
  }
  // A memory pass waiting for a usable model is active, not paused.
  if (summary.waitingReason) return attention(summary.waitingReason);
  if (summary.systemRole) return { group: "system", problem: null };
  if (shape === "repeating") return { group: "repeating", problem: null };
  if (shape === "webhook" || shape === "watch") return { group: "events", problem: null };
  if (summary.nextFireAt) return { group: "upcoming", problem: null };
  switch (summary.latestOccurrence?.status) {
    case "pending":
    case "running":
      return { group: "upcoming", problem: null };
    case "failed":
      return attention("It failed when it ran.");
    case "canceled":
      return attention("It was canceled before it ran.");
    case "succeeded":
    case undefined:
      return attention("Its time passed before it could run.");
  }
}

function attention(problem: string): AutomationPlacement {
  return { group: "attention", problem };
}

function onceAt(source: TriggerSource): number {
  return source.kind === "schedule" && source.schedule.kind === "at"
    ? Date.parse(source.schedule.at)
    : Number.POSITIVE_INFINITY;
}

export interface AutomationSection<Item extends PlaceableAutomation = TriggerSummary> {
  readonly id: AutomationGroup;
  readonly items: readonly { readonly item: Item; readonly problem: string | null }[];
  readonly title: string;
}

/** The non-empty sections, each ordered the way a person scans it. */
export function sectionAutomations<Item extends PlaceableAutomation>(
  items: readonly Item[],
  now: number,
): readonly AutomationSection<Item>[] {
  const placed = items.map((item) => ({ ...placeAutomation(item, now), item }));
  return automationGroups.flatMap(({ id, title }) => {
    const members = placed
      .filter(({ group }) => group === id)
      .sort((left, right) => compareWithin(id, left.item, right.item))
      .map(({ item, problem }) => ({ item, problem }));
    return members.length > 0 ? [{ id, items: members, title }] : [];
  });
}

function compareWithin(
  group: AutomationGroup,
  left: PlaceableAutomation,
  right: PlaceableAutomation,
): number {
  if (group === "upcoming" || group === "repeating" || group === "system") {
    // What is happening now comes first, then the soonest.
    const when = (item: PlaceableAutomation) =>
      item.nextFireAt ? Date.parse(item.nextFireAt) : Number.NEGATIVE_INFINITY;
    return when(left) - when(right) || left.name.localeCompare(right.name);
  }
  if (group === "attention") return right.updatedAt.localeCompare(left.updatedAt);
  return left.name.localeCompare(right.name);
}

const dayMilliseconds = 86_400_000;

export function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const monthDayYear = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const fullDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
  weekday: "long",
  year: "numeric",
  timeZoneName: "short",
});

/**
 * A moment as people say it: "Today, 6:00 PM", "Tomorrow, 9:00 AM",
 * "Fri, 10:00 AM" within the week, then the date. Mid-sentence, the relative
 * days are lowercase: "last ran today, 8:00 AM".
 */
export function formatMoment(iso: string, now: number, midSentence = false): string {
  const time = Date.parse(iso);
  const days = Math.round((startOfDay(time) - startOfDay(now)) / dayMilliseconds);
  const at = clock.format(time);
  const relative =
    days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : null;
  if (relative) return `${midSentence ? relative.toLowerCase() : relative}, ${at}`;
  if (Math.abs(days) < 7) return `${weekday.format(time)}, ${at}`;
  const date =
    new Date(time).getFullYear() === new Date(now).getFullYear()
      ? monthDay.format(time)
      : monthDayYear.format(time);
  return `${date}, ${at}`;
}

/** The unambiguous moment, for a title attribute or a detail line. */
export function formatFullMoment(iso: string): string {
  return fullDate.format(Date.parse(iso));
}

/** How long until a moment within the next day: "in 12 min", "in 2 h 14 min". */
export function formatCountdown(iso: string, now: number): string | null {
  const minutes = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes >= 24 * 60) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

/**
 * When it runs next, for a list's narrow right-hand column: the countdown
 * while it is today ("in 4 min" over "4:35 PM"), then the day over the time.
 */
export function formatNextRun(
  iso: string,
  now: number,
): { readonly day: string; readonly time: string } {
  const time = Date.parse(iso);
  const at = clock.format(time);
  const days = Math.round((startOfDay(time) - startOfDay(now)) / dayMilliseconds);
  if (days <= 0) return { day: formatCountdown(iso, now) ?? "Today", time: at };
  if (days === 1) return { day: "Tomorrow", time: at };
  if (days < 7) return { day: weekday.format(time), time: at };
  return {
    day:
      new Date(time).getFullYear() === new Date(now).getFullYear()
        ? monthDay.format(time)
        : monthDayYear.format(time),
    time: at,
  };
}

/** How often or on what it runs, as a row's second line says it. */
export function describeCadence(source: TriggerSource, machine: string | null): string {
  if (source.kind !== "schedule") return describeEvent(source.kind, machine);
  return source.schedule.kind === "cron" ? describeRepeating(source.schedule) : "Once";
}

/** The automation's name; Opensteer's memory passes are named for what they are. */
export function automationName(item: Pick<PlaceableAutomation, "name" | "systemRole">): string {
  return item.systemRole === "memory-light"
    ? "Light memory pass"
    : item.systemRole === "memory-nightly"
      ? "Nightly memory pass"
      : item.name;
}

const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const viewerUses24Hours =
  new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === false;

function timeZoneName(timeZone: string): string {
  return (
    new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(0)
      .find(({ type }) => type === "timeZoneName")?.value ?? timeZone
  );
}

/**
 * When a repeating schedule runs, in words: "At 8:00 AM, Monday through
 * Friday". The schedule keeps its own time zone; it is named only when it is
 * not the reader's, so "8:00 AM" never silently means someone else's morning.
 */
export function describeRepeating(schedule: Extract<TriggerSchedule, { kind: "cron" }>): string {
  let words: string;
  try {
    words = cronstrue.toString(schedule.expression, {
      trimHoursLeadingZero: true,
      use24HourTimeFormat: viewerUses24Hours,
      verbose: false,
    });
  } catch {
    // The Host validated the expression with its own parser; one this library
    // cannot put into words is still shown exactly as written.
    words = `On the schedule ${schedule.expression}`;
  }
  const zone = timeZoneName(schedule.timezone);
  return zone === timeZoneName(viewerTimeZone) ? words : `${words} (${zone})`;
}

/** How an event-driven automation starts, in words. */
export function describeEvent(shape: "webhook" | "watch", machine: string | null): string {
  if (shape === "webhook") return "When its webhook is called";
  return machine ? `Watching continuously on ${machine}` : "Watching continuously";
}

export type Tone = "ok" | "warn" | "bad" | "accent" | "muted";

/**
 * What a watch is doing right now. It restarts on its own after a crash and
 * pauses after repeated ones, so only those states need words beyond "Watching".
 */
export function watchState(observed: NonNullable<TriggerSummary["watch"]>["observed"]): {
  readonly text: string;
  readonly tone: Tone;
} {
  switch (observed) {
    case "running":
      return { text: "Watching", tone: "ok" };
    case "starting":
      return { text: "Starting", tone: "muted" };
    case "backoff":
      return { text: "Restarting after it stopped", tone: "warn" };
    case "expired":
      return { text: "Waiting for its computer", tone: "warn" };
    case "stopped":
      return { text: "Stopped", tone: "muted" };
  }
}

/** A run not started this long after it was queued is waiting on its computer. */
const startGraceMilliseconds = 60_000;

/** How the latest run went, in a few words, for a row's second line. */
export function latestRun(
  occurrence: TriggerSummary["latestOccurrence"],
  now: number,
): { readonly text: string; readonly tone: Tone } | null {
  if (!occurrence) return null;
  switch (occurrence.status) {
    case "succeeded":
      return {
        text: `Last ran ${formatMoment(occurrence.completedAt ?? occurrence.createdAt, now, true)}`,
        tone: "ok",
      };
    case "failed":
      return { text: "Last run failed", tone: "bad" };
    case "canceled":
      return { text: "Last run canceled", tone: "muted" };
    case "running":
      return { text: "Running now", tone: "accent" };
    case "pending":
      return now - Date.parse(occurrence.createdAt) < startGraceMilliseconds
        ? { text: "Starting", tone: "accent" }
        : { text: "Waiting for its computer", tone: "warn" };
  }
}

export function runOutcome(
  occurrence: TriggerOccurrence,
  replyIn: string | null,
  replyStatus: TriggerDetail["downstreamRuns"][number]["run"]["status"] | null,
  now: number,
): string {
  switch (occurrence.status) {
    case "pending":
      return now - Date.parse(occurrence.createdAt) < 60_000
        ? "Starting"
        : "Waiting for its computer";
    case "running":
      return "Running now";
    case "canceled":
      return "Canceled";
    case "failed":
      return "Failed";
    case "succeeded":
      if (replyIn === null) return "Finished without a message";
      switch (replyStatus) {
        case "completed":
          return `Opensteer replied in ${replyIn}`;
        case "failed":
        case "interrupted":
          return `Opensteer couldn’t finish in ${replyIn}`;
        default:
          return `Opensteer is working in ${replyIn}`;
      }
  }
}

export function scheduleStatusWord(
  status: TriggerSummary["status"],
  pauseReason: string | null,
): string {
  return status === "paused"
    ? pauseReason
      ? "Paused by Opensteer"
      : "Paused"
    : status === "archived"
      ? "Deleted"
      : "Active";
}
