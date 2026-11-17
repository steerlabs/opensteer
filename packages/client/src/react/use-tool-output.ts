import type { HostClient, ToolEntry } from "../host/client.js";
import { useTranscriptBody } from "./use-transcript-body.js";

/** Mount only when a person opens the step. */
export function useToolOutput(client: HostClient | null, threadId: string | null, tool: ToolEntry) {
  const cut = tool.output === undefined && tool.itemId !== undefined && tool.state !== "running";
  const state = useTranscriptBody({
    client,
    threadId,
    nodeId: tool.nodeId,
    itemId: tool.itemId,
    revision: tool.itemRevision,
    enabled: cut,
  });
  const body = state.data?.body.kind === "tool" ? state.data.body : null;
  const shown: ToolEntry = body
    ? {
        ...tool,
        arguments: body.arguments,
        output: body.output,
        outputPreview: undefined,
      }
    : tool;
  return {
    ...state,
    loading: cut && state.data === null && state.error === null,
    error: cut ? state.error : null,
    images: body?.images ?? [],
    tool: shown,
  };
}
