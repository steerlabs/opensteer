import { aiAccountTools } from "./ai-accounts.js";
import { app_publish, app_list, app_fetch } from "./apps.js";
import { pending_request, request_withdraw } from "./requests.js";
import { pluginTools } from "./plugins.js";
import { messagingBridgeTools } from "./messaging-bridges.js";
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
import { browserTools } from "./browser.js";
import { computerTools } from "./computer.js";
import { trigger_read, trigger_write } from "./triggers.js";
import { integrationTools } from "./integrations.js";
import { knowledge_read, knowledge_topics, knowledge_write } from "./knowledge.js";
export const agentTools = [
  ...aiAccountTools,
  ...computerTools,
  ...browserTools,
  ...pluginTools,
  ...messagingBridgeTools,
  app_publish,
  app_list,
  app_fetch,
  pending_request,
  request_withdraw,
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

type RequestTool = Extract<AgentTool, { readonly name: `${string}_request` }>;
const isRequestTool = (tool: AgentTool): tool is RequestTool => tool.name.endsWith("_request");
/** The tools that can open a durable Request, and so hold their call for a person. */
export const requestToolNames: readonly RequestTool["name"][] = agentTools
  .filter(isRequestTool)
  .map(({ name }) => name);

export * from "./apps.js";
export * from "./browser.js";
export * from "./computer.js";
export * from "./ai-accounts.js";
export * from "./messaging-bridges.js";
export * from "./person.js";
export * from "./plugins.js";
export * from "./team.js";
export * from "./requests.js";
export * from "./threads.js";
export * from "./triggers.js";
export * from "./integrations.js";
export * from "./knowledge.js";
