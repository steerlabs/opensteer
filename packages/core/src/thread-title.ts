import { z } from "zod";
import { surrogateSafeCut } from "./live.js";

/**
 * Who decided a Thread's title, which decides whether anything may replace it.
 * A `provisional` title is the first line of what started the Thread, shown
 * until its engine names it; the Host replaces only these, so a name a person
 * or an agent chose, or a fixed one such as a Chat or a channel conversation,
 * is never overwritten. `generated` is the engine's name.
 */
export const ThreadTitleSourceSchema = z.enum(["provisional", "generated", "chosen"]);
export type ThreadTitleSource = z.infer<typeof ThreadTitleSourceSchema>;

/** A Thread's title as every Thread record stores it. */
export const threadTitleMaxLength = 240;
export const ThreadTitleSchema = z.string().trim().min(1).max(threadTitleMaxLength);

/** What a task list row shows in full; a first-line title is cut to it. */
export const provisionalThreadTitleMaxLength = 72;

/** An engine's name for a Thread, after the Runner cleaned it up. */
export const generatedThreadTitleMaxLength = 80;
export const GeneratedThreadTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(generatedThreadTitleMaxLength);

/** How much of the Thread's first message its engine reads to name it. */
export const threadTitleRequestMaxLength = 2_000;

const provisionalFallback = "New task";

/**
 * A Thread's title before its engine names it: the first line of what started
 * it, cut to what a list row can show.
 */
export function provisionalThreadTitle(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length <= provisionalThreadTitleMaxLength) return firstLine || provisionalFallback;
  const cut = surrogateSafeCut(firstLine, provisionalThreadTitleMaxLength - 1);
  return `${firstLine.slice(0, cut).trimEnd()}…`;
}
