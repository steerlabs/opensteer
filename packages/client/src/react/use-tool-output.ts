import { useCallback } from "react";
import type { HostClient, ToolEntry } from "../host/client.js";
import { useHostRead } from "./use-host-read.js";
import { loadToolOutput } from "../host/tool-output-detail.js";

/** Mount only when a person opens the step. */
export function useToolOutput(client: HostClient | null, threadId: string | null, tool: ToolEntry) {
  const cut = tool.outputPreview?.cut === true;
  const read = useCallback(
    () => loadToolOutput(client!, threadId!, tool),
    [client, threadId, tool],
  );
  const state = useHostRead(cut && client && threadId ? read : null, `${threadId}:${tool.id}`);
  return {
    ...state,
    loading: cut && state.data === null && state.error === null,
    error: cut ? state.error : null,
    tool: state.data ? { ...tool, output: state.data, outputPreview: undefined } : tool,
  };
}
