import type { DisplayInputEvent } from "@opensteer/protocol";

/** The contract's bounds on one text event (`DisplayInputEventSchema`). */
export const maxInsertCharacters = 1_000;
const maxDeleteBackward = 100;

/** One event standing for two in a row, or null when both must be sent. */
export function mergeDisplayInput(
  last: DisplayInputEvent,
  next: DisplayInputEvent,
): DisplayInputEvent | null {
  if (last.kind === "pointer" && next.kind === "pointer")
    return last.phase === "move" && next.phase === "move" ? next : null;
  if (last.kind === "mouse" && next.kind === "mouse")
    return last.phase === "move" &&
      next.phase === "move" &&
      last.button === next.button &&
      last.modifiers.length === next.modifiers.length &&
      last.modifiers.every((modifier) => next.modifiers.includes(modifier))
      ? next
      : null;
  if (last.kind === "scroll" && next.kind === "scroll")
    return { ...next, dx: signed(last.dx + next.dx), dy: signed(last.dy + next.dy) };
  if (last.kind !== "text" || next.kind !== "text") return null;
  if ("insert" in last && "insert" in next)
    return last.insert.length + next.insert.length <= maxInsertCharacters
      ? { kind: "text", insert: last.insert + next.insert }
      : null;
  if ("deleteBackward" in last && "deleteBackward" in next)
    return last.deleteBackward + next.deleteBackward <= maxDeleteBackward
      ? { kind: "text", deleteBackward: last.deleteBackward + next.deleteBackward }
      : null;
  return null;
}

export function signed(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
}
