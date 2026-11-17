import { useCallback } from "react";
import type { HostClient, ToolEntry } from "../host/client.js";
import { useHostRead } from "./use-host-read.js";

/** Mount only when a person opens the step. */
export function useToolOutput(client: HostClient | null, threadId: string | null, tool: ToolEntry) {
  const cut = tool.output === undefined && tool.itemId !== undefined && tool.state !== "running";
  const read = useCallback(async () => {
    const result = await client!.readTranscriptItem(threadId!, tool.itemId!, tool.nodeId);
    if (result?.body.kind !== "tool") throw new Error("This step's output is unavailable.");
    return result.body;
  }, [client, threadId, tool]);
  const state = useHostRead(
    cut && client && threadId ? read : null,
    `${threadId}:${tool.itemId ?? tool.id}:${tool.itemRevision ?? ""}`,
  );
  const shown: ToolEntry = state.data
    ? {
        ...tool,
        arguments: state.data.arguments,
        output: state.data.output,
        outputPreview: undefined,
      }
    : tool;
  return {
    ...state,
    loading: cut && state.data === null && state.error === null,
    error: cut ? state.error : null,
    images: state.data?.images ?? [],
    tool: shown,
  };
}
