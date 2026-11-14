import type { ToolEntry } from "../host/client.js";

/** Shared expectations for the rows people see on web, desktop and phones. */
export const mcpPresentationScenarios = [
  ["opensteer_task_wait", {}, "Waiting for a task", "Waited for a task"],
  [
    "opensteer_task_configure",
    { aiAccountId: "hin_1" },
    "Changing a task’s AI",
    "Changed a task’s AI",
  ],
  ["opensteer_task_queue", { action: "move" }, "Reordering queued work", "Reordered queued work"],
  ["opensteer_task_interrupt", {}, "Stopping a task", "Stopped a task"],

  ["opensteer_defaults_read", {}, "Reading new-task defaults", "Read new-task defaults"],
  [
    "opensteer_ai_account_update",
    { action: "set_default" },
    "Changing the default AI account",
    "Changed the default AI account",
  ],
  ["computer_list", {}, "Looking up computers", "Looked up computers"],
  ["computer_remove", { target: "computer" }, "Removing a computer", "Removed a computer"],
  [
    "integration_remove",
    { target: "account" },
    "Disconnecting an integration",
    "Disconnected an integration",
  ],
  [
    "opensteer_messaging_bridge_update",
    { paused: true },
    "Pausing a messaging bridge",
    "Paused a messaging bridge",
  ],
  [
    "opensteer_plugin_remove",
    { target: "specialist" },
    "Removing a specialist",
    "Removed a specialist",
  ],
  [
    "browser_profile_remove",
    { target: "profile" },
    "Deleting a browser profile",
    "Deleted a browser profile",
  ],
  ["integration_search", { query: "mail" }, "Searching integrations", "Searched integrations"],
  ["computer_use", {}, "Running computer code", "Ran computer code"],
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
