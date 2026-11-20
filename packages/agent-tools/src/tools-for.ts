import {
  agentGrantToolFamilies,
  type AgentGrant,
  type AgentGrantToolFamily,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { AgentCallerKind, RunToolCapabilities } from "./registry.js";
import { agentTools, type AgentToolName } from "./tools/index.js";

/**
 * Which grant families offer a tool to work with connection lineage. `widen` asks the person for
 * more than the grant holds and `personal` reaches the person's own context; neither is offered to
 * a `selected` grant, which the person changes under Connected agents instead.
 */
type ToolFamily = readonly AgentGrantToolFamily[] | "widen" | "personal";
const tasks = ["tasks"] as const;
const browser = ["browser"] as const;
const computer = ["computer"] as const;
const plugins = ["plugins"] as const;
const settings = ["settings"] as const;
export const agentToolFamilies: Readonly<Record<AgentToolName, ToolFamily>> = {
  opensteer_ai_account_list: settings,
  opensteer_ai_account_update: settings,
  opensteer_defaults_read: settings,
  opensteer_defaults_update: settings,
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
  computer_update: settings,
  computer_remove: settings,
  computer_use: computer,
  computer_apps: computer,
  computer_access_request: "widen",
  app_access_request: "widen",
  browser_use: browser,
  browser_connect: browser,
  browser_profile_list: browser,
  browser_profile_update: settings,
  browser_profile_remove: settings,
  browser_profile_request: "widen",
  saved_login_request: browser,
  chrome_cookies_request: "widen",
  card_request: browser,
  plugin_search: plugins,
  opensteer_plugin_catalog: settings,
  plugin_skills: plugins,
  plugin_resources: settings,
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
  opensteer_messaging_bridge_list: settings,
  opensteer_messaging_bridge_update: settings,
  opensteer_messaging_bridge_remove: settings,
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
  opensteer_team_file_download: "personal",
  opensteer_team_read: "personal",
  opensteer_team_search: "personal",
  opensteer_team_post: "personal",
  opensteer_knowledge_topic_list: "personal",
  opensteer_knowledge_search: "personal",
  opensteer_knowledge_remove: "personal",
  opensteer_knowledge_read: "personal",
  opensteer_knowledge_save: "personal",
};

/**
 * Whether a grant offers a tool; no grant is the person's own work, which keeps every tool. The
 * person's settings, reads included, reach a connection only with `everything` at `full-access`.
 */
export function grantOffersTool(
  grant: AgentGrant | undefined,
  name: AgentToolName,
  accessMode: ThreadAccessMode = "full-access",
): boolean {
  if (!grant) return true;
  const family = agentToolFamilies[name];
  if (grant.scope === "everything")
    return accessMode === "full-access" || family === "widen" || family === "personal"
      ? true
      : !(family as readonly AgentGrantToolFamily[]).includes("settings");
  if (family === "widen" || family === "personal") return false;
  const granted = agentGrantToolFamilies(grant);
  return family.some((member) => granted.has(member));
}

export function toolsFor(caller: {
  readonly kind: AgentCallerKind;
  readonly program?: { readonly kind: "trigger" | "watch" };
  readonly capabilities?: RunToolCapabilities;
  readonly accessMode: ThreadAccessMode;
  readonly teamsAvailable?: boolean;
  readonly knowledge?: boolean;
  /** The grant of the connection whose lineage this work is in. */
  readonly grant?: AgentGrant;
}) {
  return agentTools.filter(
    (tool) =>
      tool.callers.some((kind) => kind === caller.kind) &&
      (caller.program?.kind !== "watch" || tool.name !== "app_access_request") &&
      (!("capability" in tool) ||
        !caller.capabilities ||
        caller.capabilities[tool.capability] === true) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (!("team" in tool) || (caller.kind === "run" && caller.teamsAvailable === true)) &&
      (!("knowledge" in tool) || (caller.kind === "run" && caller.knowledge === true)) &&
      grantOffersTool(caller.grant, tool.name, caller.accessMode),
  );
}
