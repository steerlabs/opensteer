import { ExecutionNodeIdSchema, type ToolOutput } from "@opensteer/core";
import type { HostClient, ToolEntry } from "./client.js";

const loaded = new WeakMap<HostClient, Map<string, Promise<ToolOutput>>>();

export function loadToolOutput(
  client: HostClient,
  threadId: string,
  tool: ToolEntry,
): Promise<ToolOutput> {
  if (!tool.outputPreview?.cut && tool.output) return Promise.resolve(tool.output);
  let cache = loaded.get(client);
  if (!cache) {
    cache = new Map();
    loaded.set(client, cache);
  }
  const key = `${threadId}:${tool.nodeId ?? ""}:${tool.id}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const request = (async () => {
    if (!tool.runId) throw new Error("This step has no Run.");
    const result = await client.rpc["tool.output.get"]({
      threadId,
      runId: tool.runId,
      callId: tool.callId,
      ...(tool.nodeId ? { nodeId: ExecutionNodeIdSchema.parse(tool.nodeId) } : {}),
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data.output;
  })();
  cache.set(key, request);
  void request.catch(() => {
    if (cache.get(key) === request) cache.delete(key);
  });
  return request;
}
