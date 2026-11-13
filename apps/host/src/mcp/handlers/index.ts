import { administrationToolHandlers, type AdministrationToolHandlers } from "./administration.js";
import type { AppService } from "../../apps/app-service.js";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import { requireRun } from "../operations.js";
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
  readonly apps: Pick<AppService, "publish" | "listForCaller" | "fetch">;
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
}): AgentToolHandlers {
  const p = options.product,
    i = options.integrations,
    t = options.triggers;
  const handlers: AgentToolHandlers = {
    ...administrationToolHandlers(options.administration),
    app_publish: async (c) =>
      await options.apps.publish(requireRun(c.caller).claims, c.operationKey, c.input),
    app_list: async (c) => await options.apps.listForCaller({ requestedBy: c.caller.userId }),
    app_fetch: async (c) => await options.apps.fetch(requireRun(c.caller).claims, c.input),
    plugin_install: async (c) =>
      await options.pluginInstall(requireRun(c.caller).claims, c.input.directory),
    orchestrator_capabilities: async (c) => await p.orchestrator_capabilities(c),
    environment_list: async (c) => await p.environment_list(c),
    thread_read: async (c) => await p.thread_read(c),
    thread_list: async (c) => await p.thread_list(c),
    delegate_task: Object.assign(async (c: ToolCall<"delegate_task">) => await p.delegate_task(c), {
      authorize: async (c: ToolCall<"delegate_task">) => {
        await p.authorizeDelegation(c);
      },
    }),
    thread_wait: async (c) => await p.thread_wait(c),
    thread_configure: async (c) => await p.thread_configure(c),
    thread_queue: async (c) => await p.thread_queue(c),
    thread_send: async (c) => await p.thread_send(c),
    thread_update: async (c) => await p.thread_update(c),
    thread_interrupt: async (c) => await p.thread_interrupt(c),
    task_status: async (c) => await p.task_status(c),
    task_cancel: Object.assign(async (c: ToolCall<"task_cancel">) => p.task_cancel(c), {
      targets: (c: ToolCall<"task_cancel">) => p.assignmentTargets(c),
    }),
    person_message: async (c) => await p.person_message(c),
    person_show: Object.assign(async (c: ToolCall<"person_show">) => await p.person_show(c), {
      targets: async (c: ToolCall<"person_show">) =>
        "threadId" in c.input.target ? [c.input.target.threadId] : [],
      authorize: async (c: ToolCall<"person_show">) => {
        await p.preparePersonShow(c);
      },
    }),
    pending_request: async (c) => await p.pending_request(c),
    request_withdraw: async (c) => await p.request_withdraw(c),
    browser_profile_list: async (c) => await p.browser_profile_list(c),
    use_card: async (c) => await p.use_card(c),
    use_saved_login: async (c) => await p.use_saved_login(c),
    copy_chrome_cookies: async (c) => await p.copy_chrome_cookies(c),
    browser_profile_request: async (c) => await p.browser_profile_request(c),
    device_access_request: async (c) => await p.device_access_request(c),
    machine_full_disk_access_request: async (c) => await p.machine_full_disk_access_request(c),
    browser_tab_read: async (c) => await p.browser_tab_read(c),
    browser_tab_write: async (c) => await p.browser_tab_write(c),
    browser_session_list: async (c) => await p.browser_session_list(c),
    browser_session_open: async (c) => await p.browser_session_open(c),
    browser_session_close: async (c) => await p.browser_session_close(c),
    trigger_read: async (c) => await t.trigger_read(c),
    trigger_write: async (c) => await t.trigger_write(c),
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
    computer: async (c) => await i.computer(c),
    integration_request: async (c) => await i.integration_request(c),
    integration_propose: async (c) => await i.integration_propose(c),
    ...teamToolHandlers({ port: options.team, personalContext: options.personalContextForRun }),
    ...knowledgeToolHandlers({
      port: options.knowledge,
      requestForRun: options.teamRequestForRun,
      personalContext: options.personalContextForRun,
    }),
  };
  return handlers;
}
