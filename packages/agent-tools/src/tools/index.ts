import { administrationTools } from "./administration.js";
import { app_publish, app_list, app_fetch } from "./apps.js";
import { pending_request, request_withdraw } from "./requests.js";
import { environment_list, orchestrator_capabilities } from "./environment.js";
import { plugin_install } from "./plugins.js";
import { team_read, team_search, team_post } from "./team.js";
import {
  thread_read,
  thread_list,
  delegate_task,
  task_status,
  task_cancel,
  thread_send,
  thread_interrupt,
  thread_update,
  thread_wait,
  thread_configure,
  thread_queue,
} from "./threads.js";
import { person_message, person_show } from "./person.js";
import {
  browser_profile_list,
  sign_in,
  use_card,
  browser_profile_request,
  browser_tab_read,
  browser_tab_write,
  browser_session_list,
  browser_session_open,
  browser_session_close,
} from "./browser.js";
import { device_access_request, machine_full_disk_access_request } from "./computer.js";
import { trigger_read, trigger_write } from "./triggers.js";
import { integrationTools } from "./integrations.js";
import { knowledge_read, knowledge_topics, knowledge_write } from "./knowledge.js";
export const agentTools = [
  ...administrationTools,
  app_publish,
  app_list,
  app_fetch,
  pending_request,
  request_withdraw,
  environment_list,
  orchestrator_capabilities,
  plugin_install,
  thread_read,
  thread_list,
  delegate_task,
  task_status,
  task_cancel,
  person_message,
  person_show,
  thread_send,
  thread_interrupt,
  thread_update,
  thread_wait,
  thread_configure,
  thread_queue,
  browser_profile_list,
  sign_in,
  use_card,
  browser_profile_request,
  machine_full_disk_access_request,
  device_access_request,
  browser_tab_read,
  browser_tab_write,
  browser_session_list,
  browser_session_open,
  browser_session_close,
  trigger_read,
  trigger_write,
  ...integrationTools,
  team_read,
  team_search,
  team_post,
  knowledge_topics,
  knowledge_read,
  knowledge_write,
] as const;
export type AgentTool = (typeof agentTools)[number];
export type AgentToolName = AgentTool["name"];

/** The tools that can open a durable Request, and so hold their call for a person. */
export const requestToolNames = [
  "browser_profile_request",
  "integration_propose",
  "integration_request",
  "machine_full_disk_access_request",
  "device_access_request",
  "sign_in",
  "use_card",
] as const satisfies readonly AgentToolName[];

export * from "./apps.js";
export * from "./browser.js";
export * from "./computer.js";
export * from "./environment.js";
export * from "./person.js";
export * from "./plugins.js";
export * from "./team.js";
export * from "./requests.js";
export * from "./threads.js";
export * from "./triggers.js";
export * from "./integrations.js";
export * from "./knowledge.js";

export * from "./administration.js";
