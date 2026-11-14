import { administrationTools } from "./administration.js";
import { opensteer_app_publish, opensteer_app_list, opensteer_app_call } from "./apps.js";
import {
  opensteer_request_list,
  opensteer_request_read,
  opensteer_request_answer,
  opensteer_request_withdraw,
} from "./requests.js";
import { environment_list, orchestrator_capabilities } from "./environment.js";
import { plugin_install } from "./plugins.js";
import {
  opensteer_team_file_download,
  opensteer_team_read,
  opensteer_team_search,
  opensteer_team_post,
} from "./team.js";
import {
  opensteer_task_create,
  opensteer_delegation_wait,
  opensteer_subagent_read,
  opensteer_subagent_stop,
  opensteer_task_resume,
  opensteer_task_read,
  opensteer_task_list,
  opensteer_task_delegate,
  opensteer_delegation_status,
  opensteer_delegation_cancel,
  opensteer_task_send,
  opensteer_task_interrupt,
  opensteer_task_update,
  opensteer_task_wait,
  opensteer_task_configure,
  opensteer_task_queue,
} from "./threads.js";
import { person_notify, person_show } from "./person.js";
import {
  browser_profile_list,
  copy_chrome_cookies,
  use_saved_login,
  use_card,
  browser_profile_request,
} from "./browser.js";
import { device_access_request, machine_full_disk_access_request } from "./computer.js";
import {
  opensteer_automation_read,
  opensteer_automation_update,
  opensteer_automation_control,
  opensteer_automation_list,
  opensteer_automation_create,
} from "./triggers.js";
import { integrationTools } from "./integrations.js";
import {
  opensteer_knowledge_search,
  opensteer_knowledge_remove,
  opensteer_knowledge_read,
  opensteer_knowledge_topic_list,
  opensteer_knowledge_save,
} from "./knowledge.js";
export const agentTools = [
  ...administrationTools,
  opensteer_app_publish,
  opensteer_app_list,
  opensteer_app_call,
  opensteer_request_list,
  opensteer_request_read,
  opensteer_request_answer,
  opensteer_request_withdraw,
  environment_list,
  orchestrator_capabilities,
  plugin_install,
  opensteer_task_create,
  opensteer_delegation_wait,
  opensteer_subagent_read,
  opensteer_subagent_stop,
  opensteer_task_resume,
  opensteer_task_read,
  opensteer_task_list,
  opensteer_task_delegate,
  opensteer_delegation_status,
  opensteer_delegation_cancel,
  person_notify,
  person_show,
  opensteer_task_send,
  opensteer_task_interrupt,
  opensteer_task_update,
  opensteer_task_wait,
  opensteer_task_configure,
  opensteer_task_queue,
  browser_profile_list,
  copy_chrome_cookies,
  use_saved_login,
  use_card,
  browser_profile_request,
  machine_full_disk_access_request,
  device_access_request,
  opensteer_automation_read,
  opensteer_automation_update,
  opensteer_automation_control,
  opensteer_automation_list,
  opensteer_automation_create,
  ...integrationTools,
  opensteer_team_file_download,
  opensteer_team_read,
  opensteer_team_search,
  opensteer_team_post,
  opensteer_knowledge_topic_list,
  opensteer_knowledge_search,
  opensteer_knowledge_remove,
  opensteer_knowledge_read,
  opensteer_knowledge_save,
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
  "copy_chrome_cookies",
  "use_saved_login",
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
