import {
  agentGrantToolFamilies,
  type AgentGrant,
  type AgentGrantToolFamily,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { AgentCallerKind, RunToolCapabilities } from "./registry.js";
import { discover } from "./tools/discover.js";
import { agentTools, type AgentToolName } from "./tools/index.js";

/**
 * Which grant families offer a tool to work with connection lineage. `widen` asks the person for
 * more than the grant holds and `personal` reaches the person's own context; neither is offered to
 * a `selected` grant, which the person changes under Connected agents instead.
 */
type ToolFamily = readonly AgentGrantToolFamily[] | "widen" | "owner-context";
const tasks = ["tasks"] as const;
const browser = ["browser"] as const;
const computer = ["computer"] as const;
const plugins = ["plugins"] as const;
const settings = ["settings"] as const;
export const agentToolFamilies: Readonly<Record<AgentToolName, ToolFamily>> = {
  // Home commands: offered with any family, and cut to what the caller holds by the one rule.
  opensteer_commands: ["tasks", "browser", "computer", "plugins"],
  opensteer_command: ["tasks", "browser", "computer", "plugins"],
  // Read like a command, area by area, cut by the one admission (AC1).
  opensteer_state: ["tasks", "browser", "computer", "plugins"],
  opensteer_ai_account_list: settings,
  tab_list: ["tasks", "browser"],
  tab_open: browser,
  tab_close: browser,
  tab_organize: browser,
  tab_group_update: browser,
  app_publish: settings,
  app_list: settings,
  app_start: settings,
  app_stop: settings,
  app_delete: settings,
  computer_list: computer,
  computer_use: computer,
  computer_apps: computer,
  computer_access_request: "widen",
  app_access_request: "widen",
  browser_use: browser,
  browser_connect: browser,
  browser_profile_list: browser,
  browser_profile_request: "widen",
  saved_login_request: browser,
  chrome_cookies_request: "widen",
  card_request: browser,
  plugin_search: plugins,
  opensteer_plugin_catalog: settings,
  plugin_skills: plugins,
  plugin_resources: plugins,
  opensteer_plugin_resource_update: settings,
  plugin_describe: plugins,
  plugin_call: plugins,
  plugin_execute: plugins,
  plugin_resume: plugins,
  opensteer_plugin_list: settings,
  opensteer_plugin_install: settings,
  opensteer_plugin_export: settings,
  opensteer_plugin_activate: settings,
  opensteer_plugin_remove: settings,
  plugin_account_request: "widen",
  local_server_add: settings,
  local_server_list: plugins,
  local_server_remove: settings,
  opensteer_request_list: tasks,
  opensteer_request_read: tasks,
  opensteer_request_answer: tasks,
  opensteer_request_withdraw: tasks,
  opensteer_task_create: tasks,
  opensteer_delegation_wait: tasks,
  opensteer_subagent_read: tasks,
  opensteer_subagent_stop: tasks,
  opensteer_task_resume: tasks,
  opensteer_task_read: tasks,
  opensteer_task_list: tasks,
  opensteer_task_delegate: tasks,
  opensteer_delegation_status: tasks,
  opensteer_delegation_cancel: tasks,
  discover: ["tasks", "browser", "computer", "plugins"],
  ask_person: ["tasks", "browser", "computer", "plugins"],
  send_to_person: tasks,
  show_to_person: browser,
  opensteer_task_send: tasks,
  opensteer_task_interrupt: tasks,
  opensteer_task_update: tasks,
  opensteer_task_wait: tasks,
  opensteer_task_configure: tasks,
  opensteer_task_queue: tasks,
  opensteer_automation_read: tasks,
  opensteer_automation_update: tasks,
  opensteer_automation_control: tasks,
  opensteer_automation_list: tasks,
  opensteer_automation_create: tasks,
};

/**
 * Whether a grant allows a tool in a Run or program's lineage. Work in the person's own lineage
 * has no grant ceiling. Settings in a connection's lineage require `everything` and Full access.
 */
export function grantOffersTool(
  grant: AgentGrant | undefined,
  name: AgentToolName,
  accessMode: ThreadAccessMode = "full-access",
): boolean {
  if (!grant) return true;
  const family = agentToolFamilies[name];
  if (grant.scope === "everything")
    return accessMode === "full-access" || family === "widen" || family === "owner-context"
      ? true
      : !(family as readonly AgentGrantToolFamily[]).includes("settings");
  if (family === "widen" || family === "owner-context") return false;
  const granted = agentGrantToolFamilies(grant);
  return family.some((member) => granted.has(member));
}

const connectionSurface: ReadonlySet<AgentToolName> = new Set([
  "discover",
  "opensteer_commands",
  "opensteer_command",
  "opensteer_state",
  "ask_person",
  "browser_use",
  "browser_connect",
  "saved_login_request",
  "card_request",
  "computer_use",
  "plugin_call",
  "plugin_resume",
  "plugin_execute",
  "opensteer_task_create",
  "opensteer_task_send",
  "opensteer_task_read",
  "opensteer_task_wait",
  "opensteer_task_interrupt",
]);

const removedConnectionTools = new Set<AgentToolName>(
  agentTools
    .filter(
      (tool) =>
        !connectionSurface.has(tool.name) &&
        (tool.access === "settings" || tool.callers.some((kind) => kind === "connection")),
    )
    .map(({ name }) => name),
);
export function isRemovedConnectionTool(name: AgentToolName): boolean {
  return removedConnectionTools.has(name);
}

const connectedTools = [...agentTools.filter((tool) => connectionSurface.has(tool.name)), discover];

export function toolsFor(caller: {
  readonly kind: AgentCallerKind;
  readonly program?: { readonly kind: "trigger" | "watch" };
  readonly capabilities?: RunToolCapabilities;
  readonly accessMode: ThreadAccessMode;
  /** The grant of the connection whose lineage this work is in. */
  readonly grant?: AgentGrant;
  /**
   * False for work without the person's personal context (a chat anyone in the conversation can
   * message): it is offered no automation, whose program would run as the person.
   */
  readonly personalContext?: boolean;
}) {
  return (caller.kind === "connection" ? connectedTools : agentTools).filter(
    (tool) =>
      tool.callers.some((kind) => kind === caller.kind) &&
      (caller.personalContext !== false || !tool.name.startsWith("opensteer_automation_")) &&
      (!("capability" in tool) ||
        !caller.capabilities ||
        caller.capabilities[tool.capability] === true) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (caller.kind === "connection"
        ? offersConnectionTool(caller.grant, tool.name, caller.accessMode)
        : grantOffersTool(caller.grant, tool.name, caller.accessMode)),
  );
}

function offersConnectionTool(
  grant: AgentGrant | undefined,
  name: AgentToolName,
  mode: ThreadAccessMode,
): boolean {
  if (grant?.scope === "selected") {
    if (name === "plugin_execute")
      return grant.resources.some(
        (resource) => resource.kind === "plugin" && resource.access === "read-write",
      );
    const profile = grant.resources.some(({ kind }) => kind === "browser-profile");
    if (name === "saved_login_request" || name === "card_request") return profile;
  }
  return grantOffersTool(grant, name, mode);
}
