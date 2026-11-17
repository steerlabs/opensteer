import type { RunId, ThreadId } from "@opensteer/core";
import type { RunCapabilityClaims } from "./run-capability.js";
import type { PluginElicit } from "../plugins/plugin-service.js";

/** The Run one tool call belongs to, for the operations that need one. */
export interface RunToolContext {
  readonly runId: RunId;
  readonly threadId: ThreadId;
}

/**
 * Who one tool call is for: the Thread asking, whose lineage decides whether
 * it reaches its owner's Main, and its Run when there is one. A Trigger
 * occurrence produces no Run, and the one thing that requires a Run says so
 * itself rather than every other transport carrying a context it never reads.
 */
export interface ToolCaller {
  readonly run: RunCapabilityClaims<string> | null;
  readonly threadId: ThreadId;
  /** For a call through the plugin tools: asks the person through the calling execution. */
  readonly elicit?: PluginElicit;
}
