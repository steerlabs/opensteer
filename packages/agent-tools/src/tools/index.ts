import { discover } from "./discover.js";
import { tabTools } from "./tabs.js";
import { appTools } from "./apps.js";
import { aiAccountTools } from "./ai-accounts.js";
import {
  opensteer_request_list,
  opensteer_request_read,
  opensteer_request_answer,
  opensteer_request_withdraw,
} from "./requests.js";
import { pluginTools } from "./plugins.js";
import { localServerTools } from "./local-servers.js";
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
import { ask_person, send_to_person, show_to_person } from "./person.js";
import { browserTools } from "./browser.js";
import { computerTools } from "./computer.js";
import {
  opensteer_automation_read,
  opensteer_automation_update,
  opensteer_automation_control,
  opensteer_automation_list,
  opensteer_automation_create,
} from "./triggers.js";
import { commandTools } from "./commands.js";
export const agentTools = [
  ...commandTools,
  ...aiAccountTools,
  ...tabTools,
  ...appTools,
  ...computerTools,
  ...browserTools,
  ...pluginTools,
  ...localServerTools,
  opensteer_request_list,
  opensteer_request_read,
  opensteer_request_answer,
  opensteer_request_withdraw,
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
  ask_person,
  send_to_person,
  show_to_person,
  opensteer_task_send,
  opensteer_task_interrupt,
  opensteer_task_update,
  opensteer_task_wait,
  opensteer_task_configure,
  opensteer_task_queue,
  opensteer_automation_read,
  opensteer_automation_update,
  opensteer_automation_control,
  opensteer_automation_list,
  opensteer_automation_create,
] as const;
export type AgentTool = (typeof agentTools)[number] | typeof discover;
export type AgentToolName = AgentTool["name"];

/** The tools that open a Request, and so hold their call for a person. */
export const requestToolNames: readonly AgentToolName[] = agentTools
  .filter((tool) => "opensRequest" in tool && tool.opensRequest === true)
  .map(({ name }) => name);

export { connectionStateAreas, connectionStateDescription, type StateArea } from "./commands.js";
export * from "./apps.js";
export * from "./browser.js";
export * from "./computer.js";
export * from "./ai-accounts.js";
export * from "./person.js";
export * from "./plugins.js";
export * from "./local-servers.js";
export * from "./requests.js";
export * from "./threads.js";
export * from "./triggers.js";

export * from "./tabs.js";
