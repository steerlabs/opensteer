import {
  automationName,
  automationShape,
  describeCadence,
  formatMoment,
  formatNextRun,
  latestRun,
  type AutomationSection,
  type ScheduleItem,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import type { SFSymbolName } from "../ui/symbol.js";

/** How a row is drawn, the same on iOS and Android. */
export type AutomationRowLook = "attention" | "once" | "paused" | "plain" | "system";

/** The right-hand column: when it runs next, or what it is doing now. */
export type AutomationRowTrailing =
  | { readonly kind: "next"; readonly day: string; readonly soon: boolean; readonly time: string }
  | { readonly kind: "state"; readonly text: string; readonly tone: "accent" | "muted" }
  | null;

export interface AutomationRowModel {
  readonly accessibilityLabel: string;
  readonly cadence: string;
  readonly id: string;
  readonly item: ScheduleItem;
  readonly look: AutomationRowLook;
  readonly name: string;
  /** What went wrong, in place of the cadence; set exactly for "attention". */
  readonly problem: string | null;
  /** A run that went badly while it keeps going, beside the cadence. */
  readonly runNote: { readonly text: string; readonly tone: "bad" | "warn" } | null;
  readonly symbol: SFSymbolName;
  readonly trailing: AutomationRowTrailing;
  /** Where it talks to you; Opensteer's own upkeep reports through Chat and says nothing. */
  readonly where: string | null;
}

const soonMilliseconds = 60 * 60_000;

/**
 * One automation as a row: its name, how often it runs and where it talks to
 * you, and when it runs next. A healthy run says nothing; trouble shows as
 * what went wrong.
 */
export function automationRow(
  item: ScheduleItem,
  problem: string | null,
  now: number,
): AutomationRowModel {
  const shape = automationShape(item.source);
  const paused = item.status === "paused" && problem === null;
  const system = item.systemRole != null;
  const latest = item.latestOccurrence;
  const run = latestRun(latest, now);
  const active = latest?.status === "running" || latest?.status === "pending";
  const cadence =
    paused && item.source.kind === "schedule" && item.source.schedule.kind === "at"
      ? `Set for ${formatMoment(item.source.schedule.at, now, true)}`
      : describeCadence(item.source, null);
  const trailing: AutomationRowTrailing =
    problem !== null
      ? null
      : paused
        ? { kind: "state", text: "Paused", tone: "muted" }
        : item.kind === "watch"
          ? { kind: "state", text: "Watching", tone: "accent" }
          : active && run !== null
            ? { kind: "state", text: run.tone === "warn" ? "Waiting" : "Running", tone: "accent" }
            : item.nextFireAt === null
              ? null
              : {
                  kind: "next",
                  ...formatNextRun(item.nextFireAt, now),
                  soon: Date.parse(item.nextFireAt) - now < soonMilliseconds,
                };
  const runNote =
    problem === null && !paused && run !== null && (run.tone === "bad" || run.tone === "warn")
      ? { text: run.text, tone: run.tone }
      : null;
  const where = system ? null : item.anchor.title;
  const name = automationName(item);
  const when =
    problem ??
    (trailing?.kind === "state"
      ? trailing.text
      : item.nextFireAt === null
        ? null
        : `Next ${formatMoment(item.nextFireAt, now, true)}`);
  return {
    accessibilityLabel: [
      name,
      cadence,
      when,
      runNote?.text ?? null,
      `Runs in ${system ? "Findings through Chat" : item.anchor.title}`,
    ]
      .filter((part) => part !== null)
      .join(". "),
    cadence,
    id: item.id,
    item,
    look:
      problem !== null
        ? "attention"
        : system
          ? "system"
          : paused
            ? "paused"
            : shape === "once"
              ? "once"
              : "plain",
    name,
    problem,
    runNote,
    symbol:
      problem !== null
        ? "exclamationmark.circle"
        : item.systemRole === "memory-nightly"
          ? "moon"
          : system
            ? "sparkles"
            : shape === "repeating"
              ? "repeat"
              : shape === "webhook"
                ? "bolt"
                : shape === "watch"
                  ? "eye"
                  : "clock",
    trailing,
    where,
  };
}

/** A section's words under its rows, where it has any. */
export function sectionNote(id: AutomationSection["id"]): string | null {
  if (id === "upcoming") return "Once a one-time automation has run, it leaves this list.";
  if (id === "system") return "Opensteer’s own upkeep. What it learns reaches you in Chat.";
  return null;
}

/** The props both platforms' lists draw from. */
export interface AutomationListProps {
  /** Above the list: the Host is out of reach and this is the last answer. */
  readonly banner: ReactNode;
  /** The Host answers with at most this many, so a full answer may not be all. */
  readonly capped: boolean;
  readonly onOpen: (triggerId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly sections: readonly {
    readonly id: AutomationSection["id"];
    readonly rows: readonly AutomationRowModel[];
    readonly title: string;
  }[];
}
