import { appToolHandlers } from "./apps.js";
import { TabToolHandlers } from "./tabs.js";
import { administrationToolHandlers, type AdministrationToolHandlers } from "./administration.js";
import type { AppService } from "../../apps/app-service.js";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";

import type { ProductToolHandlers } from "./product.js";
import type { IntegrationToolHandlers } from "./integrations.js";
import type { TriggerToolHandlers } from "./triggers.js";
import type { TeamKnowledgePort, TeamToolPort } from "../team-tool-port.js";
import { knowledgeToolHandlers, teamToolHandlers } from "./team.js";
import type { RunId, TeamAgentRequestId, ThreadId } from "@opensteer/core";

export type { AgentToolHandlers, ToolCall, ToolInput } from "./types.js";
import type { AgentToolHandlers, ToolCall } from "./types.js";
export function agentToolHandlers(options: {
  readonly administration: AdministrationToolHandlers;
  readonly product: ProductToolHandlers;
  readonly integrations: IntegrationToolHandlers;
  readonly triggers: TriggerToolHandlers;
  readonly apps: Pick<AppService, "publish" | "list" | "start" | "stop" | "delete">;
  readonly tabs: TabToolHandlers;
  readonly pluginInstall: (
    scope: RunToolScope,
    directory: string,
  ) => Promise<Record<string, unknown>>;
  readonly team?: TeamToolPort;
  readonly knowledge?: TeamKnowledgePort;
  /** Whether a Run may still use its owner's personal context, rechecked per call. */
  readonly personalContextForRun: (runId: RunId) => Promise<boolean>;
  readonly teamRequestForRun: (
    runId: RunId,
    threadId: ThreadId,
  ) => Promise<TeamAgentRequestId | null>;
}): Partial<AgentToolHandlers> {
  const p = options.product,
    i = options.integrations,
    t = options.triggers;
  const handlers: Partial<AgentToolHandlers> = {
    ...administrationToolHandlers(options.administration, options.pluginInstall),
    ...appToolHandlers(options.apps),
    tab_list: (c) => options.tabs.tab_list(c),
    tab_open: (c) => options.tabs.tab_open(c),
    tab_close: (c) => options.tabs.tab_close(c),
    tab_organize: (c) => options.tabs.tab_organize(c),
    tab_group_update: (c) => options.tabs.tab_group_update(c),
    opensteer_ai_account_list: async (c) => await p.opensteer_ai_account_list(c),
    opensteer_task_create: Object.assign(
      async (c: ToolCall<"opensteer_task_create">) =>
        p.opensteer_task_delegate({ ...c, input: { ...c.input, create: true } }),
      {
        authorize: async (c: ToolCall<"opensteer_task_create">) => {
          await p.authorizeDelegation({ ...c, input: { ...c.input, create: true } });
        },
      },
    ),
    opensteer_subagent_read: async (c) => p.opensteer_task_read({ ...c, input: { ...c.input } }),
    opensteer_subagent_stop: Object.assign(
      async (c: ToolCall<"opensteer_subagent_stop">) => p.opensteer_delegation_cancel(c),
      { targets: (c: ToolCall<"opensteer_subagent_stop">) => p.assignmentTargets(c) },
    ),
    opensteer_delegation_wait: async (c) => p.opensteer_task_wait(c),
    opensteer_task_resume: async (c) =>
      p.opensteer_task_queue({ ...c, input: { ...c.input, action: "resume" } }),
    opensteer_task_read: async (c) => await p.opensteer_task_read(c),
    opensteer_task_list: async (c) => await p.opensteer_task_list(c),
    opensteer_task_delegate: Object.assign(
      async (c: ToolCall<"opensteer_task_delegate">) => await p.opensteer_task_delegate(c),
      {
        authorize: async (c: ToolCall<"opensteer_task_delegate">) => {
          await p.authorizeDelegation(c);
        },
      },
    ),
    opensteer_task_wait: async (c) => await p.opensteer_task_wait(c),
    opensteer_task_configure: async (c) => await p.opensteer_task_configure(c),
    opensteer_task_queue: async (c) => await p.opensteer_task_queue(c),
    opensteer_task_send: async (c) => await p.opensteer_task_send(c),
    opensteer_task_update: async (c) => await p.opensteer_task_update(c),
    opensteer_task_interrupt: async (c) => await p.opensteer_task_interrupt(c),
    opensteer_delegation_status: async (c) => await p.opensteer_delegation_status(c),
    opensteer_delegation_cancel: Object.assign(
      async (c: ToolCall<"opensteer_delegation_cancel">) => p.opensteer_delegation_cancel(c),
      {
        targets: (c: ToolCall<"opensteer_delegation_cancel">) => p.assignmentTargets(c),
      },
    ),
    ask_person: async (c) => await p.ask_person(c),
    person_notify: async (c) => await p.person_notify(c),
    person_show: Object.assign(async (c: ToolCall<"person_show">) => await p.person_show(c), {
      targets: async (c: ToolCall<"person_show">) =>
        "taskId" in c.input.target ? [c.input.target.taskId] : [],
      authorize: async (c: ToolCall<"person_show">) => {
        await p.preparePersonShow(c);
      },
    }),
    opensteer_request_list: async (c) =>
      p.opensteer_request_answer({ ...c, input: { ...c.input, action: "list" } }),
    opensteer_request_read: async (c) =>
      p.opensteer_request_answer({ ...c, input: { ...c.input, action: "read", limit: 50 } }),
    opensteer_request_answer: async (c) =>
      await p.opensteer_request_answer({
        ...c,
        input: { ...c.input, action: "respond", limit: 50 },
      }),
    opensteer_request_withdraw: async (c) => await p.opensteer_request_withdraw(c),
    card_request: async (c) => await p.card_request(c),
    saved_login_request: async (c) => await p.saved_login_request(c),
    chrome_cookies_request: async (c) => await p.chrome_cookies_request(c),
    browser_profile_request: async (c) => await p.browser_profile_request(c),
    computer_access_request: async (c) => await p.computer_access_request(c),
    opensteer_automation_read: async (c) => t.read(c),
    opensteer_automation_update: async (c) => t.write(c),
    opensteer_automation_control: async (c) => t.write(c),
    opensteer_automation_list: async (c) => await t.read(c),
    opensteer_automation_create: async (c) => await t.write(c),
    integration_search: async (c) => await i.integration_search(c),
    integration_describe: async (c) => await i.integration_describe(c),
    integration_call: Object.assign(
      async (c: ToolCall<"integration_call">) => await i.integration_call(c),
      {
        authorize: async (c: ToolCall<"integration_call">) => {
          await i.authorizeCall(c);
        },
      },
    ),
    computer_use: async (c) => await i.computer_use(c),
    integration_request: async (c) => await i.integration_request(c),
    app_access_request: async (c) => await i.app_access_request(c),
    custom_integration_request: async (c) => await i.custom_integration_request(c),
    ...teamToolHandlers({ port: options.team, personalContext: options.personalContextForRun }),
    ...knowledgeToolHandlers({
      port: options.knowledge,
      requestForRun: options.teamRequestForRun,
      personalContext: options.personalContextForRun,
    }),
  };
  return handlers;
}
