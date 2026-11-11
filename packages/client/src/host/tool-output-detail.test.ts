import { createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import type { HostClient, ToolEntry } from "./client.js";
import { loadToolOutput } from "./tool-output-detail.js";

it("shares an opened output, retains it after close, and permits retry after a failed read", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true, data: { output: { text: "whole output" } } });
  const client = { rpc: { "tool.output.get": read } } as unknown as HostClient;
  const tool: ToolEntry = {
    arguments: {},
    callId: "call",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "tool:call",
    integration: null,
    isError: false,
    kind: "tool",
    output: { text: "whole" },
    outputPreview: { bytes: 12, cut: true, digest: "unused" },
    runId: createId("run"),
    state: "done",
    streamText: "",
    tool: null,
  };
  await expect(loadToolOutput(client, "thread", tool)).rejects.toThrow("offline");
  const opened = loadToolOutput(client, "thread", tool);
  expect(loadToolOutput(client, "thread", tool)).toBe(opened);
  await expect(opened).resolves.toEqual({ text: "whole output" });
  await expect(loadToolOutput(client, "thread", tool)).resolves.toEqual({ text: "whole output" });
  expect(read).toHaveBeenCalledTimes(2);
});
