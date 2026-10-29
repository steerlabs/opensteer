import { z } from "zod";
import type { WorkspaceIconName } from "./workspace-icons.js";

/**
 * The colours a task or a specialist is drawn in. A task's colour is fixed at
 * creation so its row, the faces on its tabs and its cursor match; a
 * specialist's is chosen. Red and amber are absent because they mean failed
 * and needs you. Stored by name, so redrawing the palette never recolours
 * anything.
 */
export const markColors = ["lime", "green", "teal", "sky", "blue", "purple", "magenta"] as const;
export const MarkColorSchema = z.enum(markColors);
export type MarkColor = z.infer<typeof MarkColorSchema>;

/** The order new marks take their colour in: each one sits far round the wheel from the last. */
export const markColorAllocationOrder: readonly MarkColor[] = [
  "blue",
  "lime",
  "magenta",
  "teal",
  "purple",
  "green",
  "sky",
];

/** How many of a creator's newest marks a new one avoids: all but one colour. */
export const markColorRecentWindow = markColors.length - 1;

/**
 * A new mark's colour: the first in allocation order that none of `recent`
 * (the creator's newest marks of the same kind) wears, so any seven made in a
 * row all differ.
 */
export function nextMarkColor(recent: readonly MarkColor[]): MarkColor {
  const worn = new Set(recent.slice(0, markColorRecentWindow));
  return markColorAllocationOrder.find((color) => !worn.has(color)) ?? markColorAllocationOrder[0]!;
}

/**
 * Who decided a Thread's symbol, which decides whether anything may replace
 * it, exactly as `ThreadTitleSource` does for its title. Only `provisional`
 * symbols are generated; a person's or an agent's choice, and Chat's lack of
 * one, are `chosen`.
 */
export const ThreadIconSourceSchema = z.enum(["provisional", "generated", "chosen"]);
export type ThreadIconSource = z.infer<typeof ThreadIconSourceSchema>;

/** The symbol of a task with nothing more specific to show, and of "Use default". */
export const defaultTaskSymbol = "document" satisfies WorkspaceIconName;

/**
 * The symbols a Thread's engine may give it: drawings that stay legible at
 * 16px and name one kind of errand. Near-duplicates, generic marks a model
 * would reach for every time (search, sparkles, folder) and the default
 * document are left out; a person may still choose any Workspace icon.
 */
export const taskSymbolNames = [
  "mail",
  "inbox",
  "calendar",
  "plane",
  "luggage",
  "hotel",
  "pin",
  "map",
  "car",
  "train",
  "bike",
  "house",
  "building",
  "sofa",
  "bed",
  "shirt",
  "cart",
  "bag",
  "tag",
  "package",
  "truck",
  "receipt",
  "wallet",
  "card",
  "bank",
  "chart",
  "calculator",
  "briefcase",
  "handshake",
  "person",
  "people",
  "phone",
  "chat",
  "megaphone",
  "news",
  "book",
  "graduation",
  "pen",
  "checklist",
  "target",
  "trophy",
  "lightbulb",
  "rocket",
  "code",
  "bug",
  "shield",
  "key",
  "scale",
  "health",
  "stethoscope",
  "pill",
  "dumbbell",
  "baby",
  "dog",
  "utensils",
  "coffee",
  "sprout",
  "weather",
  "music",
  "mic",
  "camera",
  "film",
  "palette",
  "gamepad",
  "gift",
  "party",
  "ticket",
  "tent",
  "mountain",
  "wrench",
  "bolt",
  "bell",
  "clock",
  "compass",
  "heart",
  "care",
  "languages",
] as const satisfies readonly WorkspaceIconName[];
export type TaskSymbolName = (typeof taskSymbolNames)[number];
