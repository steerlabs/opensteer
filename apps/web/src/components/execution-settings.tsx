import type { ModelSelection, ThreadAccessMode } from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import type { AccessModeEngine } from "./access-mode-control.js";

/** The conversation's access mode, and how a change to it is applied. */
export interface ExecutionAccess {
  /** Null while no engine is chosen: nothing is ruled out yet. */
  readonly engine: AccessModeEngine | null;
  readonly mode: ThreadAccessMode;
  readonly onApply: (mode: ThreadAccessMode) => Promise<void> | void;
}

/**
 * What the choice in force can still be set to, beside which model runs it:
 * the model's own options (reasoning, speed and the like) and the access mode.
 */
export interface ExecutionSettings {
  readonly access: ExecutionAccess | null;
  /** The choice the settings belong to, "Codex · GPT-5.6-Sol"; null while nothing runs. */
  readonly current: string | null;
  readonly options: {
    readonly model: HarnessModelDescriptor;
    readonly onChange: (options: ModelSelection["options"]) => void;
    readonly values: ModelSelection["options"];
  } | null;
}
