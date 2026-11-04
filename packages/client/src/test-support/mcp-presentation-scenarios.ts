import type { ToolEntry } from "../host/client.js";

/** Shared expectations for the rows people see on web, desktop and phones. */
export const mcpPresentationScenarios = [
  ["thread_wait", {}, "Waiting for a task", "Waited for a task"],
  ["thread_configure", { action: "set" }, "Changing a task’s AI", "Changed a task’s AI"],
  ["thread_queue", { action: "resume" }, "Resuming queued work", "Resumed queued work"],
  ["thread_write", { action: "interrupt" }, "Stopping a task", "Stopped a task"],
  ["project_write", { action: "recover" }, "Recovering a project", "Recovered a project"],
  ["settings_read", {}, "Reading settings", "Read settings"],
  [
    "settings_write",
    { action: "set_default" },
    "Changing the default AI",
    "Changed the default AI",
  ],
  ["computer_list", {}, "Looking up computers", "Looked up computers"],
  ["computer_write", { action: "revoke" }, "Revoking a computer", "Revoked a computer"],
  [
    "integration_manage",
    { action: "disconnect" },
    "Disconnecting an integration",
    "Disconnected an integration",
  ],
  [
    "channel_manage",
    { action: "pause" },
    "Pausing a messaging channel",
    "Paused a messaging channel",
  ],
  [
    "plugin_manage",
    { action: "remove_specialist" },
    "Removing a specialist",
    "Removed a specialist",
  ],
  [
    "browser_profile_write",
    { action: "delete" },
    "Deleting a browser profile",
    "Deleted a browser profile",
  ],
  ["integration_search", { query: "mail" }, "Searching integrations", "Searched integrations"],
  ["computer", {}, "Running computer code", "Ran computer code"],
] as const;

export function mcpPresentationTool(name: string, args: unknown, running: boolean): ToolEntry {
  return {
    arguments: args,
    callId: `call-${name}`,
    completedAt: running ? null : "2026-11-03T10:00:04.000Z",
    createdAt: "2026-11-03T10:00:01.000Z",
    id: `tool:run:${name}`,
    integration: null,
    isError: false,
    kind: "tool",
    output: undefined,
    runId: "run",
    state: running ? "running" : "done",
    streamText: "",
    tool: { name, namespace: "opensteer" },
  };
}
