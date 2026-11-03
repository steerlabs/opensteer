import { app_publish, app_list, app_fetch } from "./apps.js";
import { request_list, request_withdraw } from "./requests.js";
import { environment_list } from "./environment.js";
import { project_list, project_create, plugin_install } from "./projects.js";
import {
  thread_read,
  thread_list,
  thread_delegate,
  assignment_cancel,
  thread_message,
  thread_write,
  thread_wait,
  thread_configure,
  thread_queue,
} from "./threads.js";
import { person_message, person_show } from "./person.js";
import {
  browser_profile_list,
  sign_in,
  browser_access_request,
  browser_tab_read,
  browser_tab_write,
  browser_session_list,
  browser_session_open,
  browser_profile_create,
  browser_session_close,
} from "./browser.js";
import { machine_full_disk_access_request } from "./computer.js";
import { trigger_read, trigger_write } from "./triggers.js";
import { integrationTools } from "./integrations.js";
export const agentTools = [
  app_publish,
  app_list,
  app_fetch,
  request_list,
  request_withdraw,
  environment_list,
  project_list,
  project_create,
  plugin_install,
  thread_read,
  thread_list,
  thread_delegate,
  assignment_cancel,
  person_message,
  person_show,
  thread_message,
  thread_write,
  thread_wait,
  thread_configure,
  thread_queue,
  browser_profile_list,
  sign_in,
  browser_access_request,
  machine_full_disk_access_request,
  browser_tab_read,
  browser_tab_write,
  browser_session_list,
  browser_session_open,
  browser_profile_create,
  browser_session_close,
  trigger_read,
  trigger_write,
  ...integrationTools,
] as const;
export type AgentTool = (typeof agentTools)[number];
export type AgentToolName = AgentTool["name"];

export * from "./apps.js";
export * from "./browser.js";
export * from "./computer.js";
export * from "./environment.js";
export * from "./person.js";
export * from "./projects.js";
export * from "./requests.js";
export * from "./threads.js";
export * from "./triggers.js";
export * from "./integrations.js";
