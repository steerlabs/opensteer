import { administrationToolHandlers, type AdministrationToolHandlers } from "./administration.js";
import type { AgentTool } from "@opensteer/agent-tools";
import type { z } from "zod";
import type { AgentCaller } from "../agent-caller.js";
import type { AppService } from "../../apps/app-service.js";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import { requireRun } from "../operations.js";
import type { ProductToolHandlers } from "./product.js";
import type { IntegrationToolHandlers } from "./integrations.js";
import type { TriggerToolHandlers } from "./triggers.js";
import type { KnowledgeManager } from "../../knowledge/knowledge-manager.js";
import { OpensteerError } from "@opensteer/core";

type ToolByName = { [T in AgentTool as T["name"]]: T };
export type ToolInput<Name extends AgentTool["name"]> = z.output<ToolByName[Name]["input"]>;
export type ToolCall<Name extends AgentTool["name"]> = {
  readonly caller: AgentCaller;
  readonly input: ToolInput<Name>;
  readonly operationKey: string;
  readonly signal?: AbortSignal;
  readonly checkLive?: () => Promise<void>;
};
// Domains may return richer records; callTool validates and projects the wire output once.
export type AgentToolHandlers = {
  [T in AgentTool as T["name"]]: ((call: ToolCall<T["name"]>) => Promise<unknown>) & {
    readonly targets?: (call: ToolCall<T["name"]>) => Promise<readonly string[]>;
    readonly authorize?: (call: ToolCall<T["name"]>) => Promise<void>;
  };
};
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
  readonly knowledge?: Pick<KnowledgeManager, "sql"> | undefined;
}): AgentToolHandlers {
  const p = options.product,
    i = options.integrations,
    t = options.triggers;
  const handlers: AgentToolHandlers = {
    ...administrationToolHandlers(options.administration),
    app_publish: async (c) =>
      await options.apps.publish(requireRun(c.caller).claims, c.operationKey, c.input),
    app_list: async (c) =>
      await options.apps.listForCaller({ requestedBy: c.caller.userId, reach: c.caller.reach }),
    app_fetch: async (c) => await options.apps.fetch(requireRun(c.caller).claims, c.input),
    plugin_install: async (c) =>
      await options.pluginInstall(requireRun(c.caller).claims, c.input.directory),
    orchestrator_capabilities: async (c) => await p.orchestrator_capabilities(c),
    environment_list: async (c) => await p.environment_list(c),
    project_list: async (c) => await p.project_list(c),
    project_create: async (c) => await p.project_create(c),
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
    sign_in: async (c) => await p.sign_in(c),
    browser_profile_request: async (c) => await p.browser_profile_request(c),
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
    sql: async (c) => {
      if (!options.knowledge)
        throw new OpensteerError({
          code: "forbidden",
          message: "This tool is unavailable to this caller",
        });
      return await options.knowledge.sql({
        caller: c.caller,
        input: c.input,
        operationKey: c.operationKey,
        ...(c.checkLive ? { checkLive: c.checkLive } : {}),
      });
    },
  };
  return handlers;
}
