import type { MarkColor, WorkspaceIconName } from "@opensteer/core";
import type { HostSnapshot } from "./client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";

/**
 * How each mark colour is drawn, the same on every client.
 * - `glyph` strokes a task's symbol on the dark surfaces (7.9:1 or more on
 *   `--bg`), in the OKLCH palette of `MarkColorSchema`.
 * - `cursor` is the same hue deepened until white 11px label text on it
 *   reaches 4.5:1, so an agent's cursor reads on light and dark pages alike.
 * - `tile` is a specialist's filled tile, light to dark, under a white glyph.
 * - `wash` is a task's tile under its `glyph`: the tile's dark stop at 70%
 *   over `--surface`, quiet enough that a long list of tasks stays calm.
 */
export const markColorPaint: Readonly<
  Record<
    MarkColor,
    {
      readonly glyph: string;
      readonly cursor: string;
      readonly tile: readonly [string, string];
      readonly wash: string;
    }
  >
> = {
  lime: { glyph: "#beea63", cursor: "#5d8200", tile: ["#677f37", "#2c3814"], wash: "#242c13" },
  green: { glyph: "#6fda75", cursor: "#098926", tile: ["#4b844e", "#1e3b1f"], wash: "#1a2e1b" },
  teal: { glyph: "#49d6cc", cursor: "#00847c", tile: ["#3b827c", "#153a37"], wash: "#142d2b" },
  sky: { glyph: "#59c5f5", cursor: "#007eab", tile: ["#447c97", "#1a3744"], wash: "#172b34" },
  blue: { glyph: "#6fa2ff", cursor: "#4474cf", tile: ["#5774a9", "#24334e"], wash: "#1e283b" },
  purple: { glyph: "#ba93fb", cursor: "#8962c5", tile: ["#7d68a2", "#372c4a"], wash: "#2b2439" },
  magenta: { glyph: "#ea7dd5", cursor: "#b74ea5", tile: ["#995c8c", "#45273f"], wash: "#352031" },
};

/** Opensteer's own cursor, for Chat: the product's ember, deepened the same way. */
export const homeCursorPaint = "#a46149";

/**
 * What a task's mark draws: its symbol, or null while it has none (not yet
 * named, or from before tasks had symbols), and its colour, or null when an
 * older Host sent none. Either missing leaves the tile neutral.
 */
export interface TaskMark {
  readonly icon: WorkspaceIconName | null;
  readonly color: MarkColor | null;
}

export function taskMark(thread: {
  readonly icon: WorkspaceIconName | null;
  readonly color?: MarkColor | null | undefined;
}): TaskMark {
  return { icon: thread.icon, color: thread.color ?? null };
}

/**
 * Occupants, cursors and bylines keep only a Thread id. Resolve its current
 * mark here rather than caching mutable icons in their activity transports.
 */
export function threadMark(
  threadId: string,
  snapshot: Pick<HostSnapshot, "threads" | "tasks" | "activeTasks" | "workspaceTasks">,
): TaskMark {
  return taskMark(threadInDirectory(threadId, snapshot) ?? { icon: null, color: null });
}
