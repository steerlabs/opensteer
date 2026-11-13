import type { TeamTopicLevel } from "@opensteer/protocol";
import type { TopicEveryoneLevel } from "@opensteer/client/team";

/** "just now", "12m ago", "3:15 PM", "Yesterday", "Nov 2". */
export function noteWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 6 * 60) return `${Math.floor(minutes / 60)}h ago`;
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function noteCountWords(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}

export function failureWords(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

export const levelWords: Readonly<Record<TeamTopicLevel | TopicEveryoneLevel, string>> = {
  none: "None",
  read: "Read",
  write: "Write",
  manage: "Manage",
};
