import type { ThreadAccessMode } from "@opensteer/core";

export interface AccessModeOption {
  description: string;
  label: string;
  mode: ThreadAccessMode;
}

/**
 * How much a Thread may do without asking, in the order a reader trades
 * supervision for speed. The words are the product's, not the protocol's, so
 * every client offers the same four choices described the same way.
 */
export const accessModeOptions: readonly AccessModeOption[] = [
  {
    description: "Ask before commands and file changes.",
    label: "Supervised",
    mode: "approval-required",
  },
  {
    description: "Auto-approve edits, ask before other actions.",
    label: "Auto-accept edits",
    mode: "auto-accept-edits",
  },
  {
    description: "Approve routine actions; ask before anything else.",
    label: "Auto",
    mode: "auto",
  },
  {
    description: "Allow commands and edits without prompts.",
    label: "Full access",
    mode: "full-access",
  },
];

/**
 * Why this engine cannot be held to this mode, or null when it can. An engine
 * declares the modes it enforces and the Host refuses the rest, so a control
 * says which engine cannot keep the promise instead of quietly running the
 * Thread under a different one. A null declaration is the engine saying
 * nothing — the work location is away — and rules nothing out.
 */
export function accessModeUnavailableReason(
  mode: ThreadAccessMode,
  engine: {
    readonly accessModes: readonly ThreadAccessMode[] | null;
    readonly engineName: string;
  },
): string | null {
  if (engine.accessModes === null || engine.accessModes.includes(mode)) return null;
  return `${engine.engineName} cannot enforce this mode`;
}

/**
 * Why work cannot start in this mode on this engine, in the words a composer
 * shows beside its blocked send; null when the engine can enforce the mode.
 */
export function accessModeConflict(
  mode: ThreadAccessMode,
  engine: {
    readonly accessModes: readonly ThreadAccessMode[] | null;
    readonly engineName: string;
  },
): string | null {
  if (accessModeUnavailableReason(mode, engine) === null) return null;
  const label = accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;
  return `${engine.engineName} can't run in ${label}. Choose another access mode.`;
}
