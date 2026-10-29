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

export type AutomationGroup = "attention" | "upcoming" | "repeating" | "events" | "paused";

/** The page's sections, in the order a person reads them. */
export const automationGroups: readonly { readonly id: AutomationGroup; readonly title: string }[] =
  [
    { id: "attention", title: "Needs attention" },
    { id: "upcoming", title: "Coming up" },
    { id: "repeating", title: "Repeating" },
    { id: "events", title: "When something happens" },
    { id: "paused", title: "Paused" },
  ];

export interface AutomationPlacement {
  readonly group: AutomationGroup;
  /** What is wrong, in plain words; set exactly when the group is "attention". */
  readonly problem: string | null;
}

/**
 * Where one automation belongs. Something needs its owner when Opensteer
 * paused it, or when a one-time automation's moment came and went without a
 * successful run — a successful one finishes it and it leaves the list.
 */
export function placeAutomation(summary: TriggerSummary, now: number): AutomationPlacement {
  const shape = automationShape(summary.source);
  if (summary.status === "paused") {
    if (summary.pauseReason) return attention(summary.pauseReason);
    if (shape === "once" && onceAt(summary.source) <= now) {
      return attention("Its time passed while it was paused.");
    }
    return { group: "paused", problem: null };
  }
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

export interface AutomationSection {
  readonly id: AutomationGroup;
  readonly items: readonly { readonly problem: string | null; readonly summary: TriggerSummary }[];
  readonly title: string;
}

/** The non-empty sections, each ordered the way a person scans it. */
export function sectionAutomations(
  summaries: readonly TriggerSummary[],
  now: number,
): readonly AutomationSection[] {
  const placed = summaries.map((summary) => ({ ...placeAutomation(summary, now), summary }));
  return automationGroups.flatMap(({ id, title }) => {
    const items = placed
      .filter(({ group }) => group === id)
      .sort((left, right) => compareWithin(id, left.summary, right.summary))
      .map(({ problem, summary }) => ({ problem, summary }));
    return items.length > 0 ? [{ id, items, title }] : [];
  });
}

function compareWithin(group: AutomationGroup, left: TriggerSummary, right: TriggerSummary) {
  if (group === "upcoming" || group === "repeating") {
    // What is happening now comes first, then the soonest.
    const when = (summary: TriggerSummary) =>
      summary.nextFireAt ? Date.parse(summary.nextFireAt) : Number.NEGATIVE_INFINITY;
    return when(left) - when(right) || left.name.localeCompare(right.name);
  }
  if (group === "attention") return right.updatedAt.localeCompare(left.updatedAt);
  return left.name.localeCompare(right.name);
}

const dayMilliseconds = 86_400_000;

function startOfDay(time: number): number {
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
