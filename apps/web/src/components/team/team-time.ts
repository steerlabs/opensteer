const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const longWeekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const monthDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fullDay = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  weekday: "long",
});

const dayMs = 86_400_000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar days from `iso` to `now`: 0 today, 1 yesterday. */
function daysAgo(iso: string, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(Date.parse(iso))) / dayMs);
}

/** A message's time in its row: "9:04". */
export function clockTime(iso: string): string {
  return clock.format(new Date(iso));
}

/** When, short, for lists: "9:04" today, "Mon" this week, "Nov 2" before. */
export function shortWhen(iso: string, now = Date.now()): string {
  const days = daysAgo(iso, now);
  if (days <= 0) return clock.format(new Date(iso));
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(new Date(iso));
  return monthDay.format(new Date(iso));
}

/** When, for something just changed: "Just now", "12m ago", then as {@link shortWhen}. */
export function recentWhen(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  return shortWhen(iso, now);
}

/** A date without its time, for what is coming: "Nov 18". */
export function shortDate(iso: string): string {
  return monthDay.format(new Date(iso));
}

/** A day separator's words: "Today", "Yesterday", "Monday", "Monday, November 3". */
export function dayLabel(iso: string, now = Date.now()): string {
  const days = daysAgo(iso, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return longWeekday.format(new Date(iso));
  return fullDay.format(new Date(iso));
}

export function sameDay(a: string, b: string): boolean {
  return startOfDay(Date.parse(a)) === startOfDay(Date.parse(b));
}

/** How long something took or has run: "40s", "1m 12s", "2h 5m". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** How long ago, for a quiet trailing column: "now", "4m", "2h", "Mon". */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return shortWhen(iso, now);
}
