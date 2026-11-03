import * as specs from "@opensteer/agent-tools/tools";
import type { AgentTool } from "@opensteer/agent-tools";
import type { z } from "zod";
import type { AgentCaller } from "../agent-caller.js";
import type { AppService } from "../../apps/app-service.js";
import type { AgentControlRunScope } from "../../agents/agent-control-service.js";
import { requireRun } from "../operations.js";
import type { ProductToolHandlers } from "./product.js";
import type { IntegrationToolHandlers } from "./integrations.js";
import type { TriggerToolHandlers } from "./triggers.js";

type ToolByName = { [T in AgentTool as T["name"]]: T };
export type ToolInput<Name extends AgentTool["name"]> = z.output<ToolByName[Name]["input"]>;
export type ToolCall<Name extends AgentTool["name"]> = {
  readonly caller: AgentCaller;
  readonly input: ToolInput<Name>;
  readonly operationKey: string;
  readonly signal?: AbortSignal;
};
export type AgentToolHandlers = {
  [T in AgentTool as T["name"]]: ((call: ToolCall<T["name"]>) => Promise<z.input<T["output"]>>) & {
    readonly authorize?: (call: ToolCall<T["name"]>) => Promise<void>;
    readonly recover?: (call: ToolCall<T["name"]>) => Promise<z.input<T["output"]>>;
  };
};
export function agentToolHandlers(options: {
  readonly product: ProductToolHandlers;
  readonly integrations: IntegrationToolHandlers;
  readonly triggers: TriggerToolHandlers;
  readonly apps: Pick<AppService, "publish" | "list" | "fetch">;
  readonly pluginInstall: (
    scope: AgentControlRunScope,
    directory: string,
  ) => Promise<Record<string, unknown>>;
}): AgentToolHandlers {
  const p = options.product,
    i = options.integrations,
    t = options.triggers;
  const handlers: AgentToolHandlers = {
    app_publish: async (c) =>
      specs.app_publish.output.parse(
        await options.apps.publish(requireRun(c.caller).claims, c.operationKey, c.input),
      ),
    app_list: async (c) =>
      specs.app_list.output.parse(await options.apps.list(requireRun(c.caller).claims)),
    app_fetch: async (c) =>
      specs.app_fetch.output.parse(await options.apps.fetch(requireRun(c.caller).claims, c.input)),
    plugin_install: async (c) =>
      specs.plugin_install.output.parse(
        await options.pluginInstall(requireRun(c.caller).claims, c.input.directory),
      ),
    environment_list: async (c) => specs.environment_list.output.parse(await p.environment_list(c)),
    project_list: async (c) => specs.project_list.output.parse(await p.project_list(c)),
    project_create: async (c) => specs.project_create.output.parse(await p.project_create(c)),
    thread_read: async (c) => specs.thread_read.output.parse(await p.thread_read(c)),
    thread_list: async (c) => specs.thread_list.output.parse(await p.thread_list(c)),
    thread_delegate: Object.assign(
      async (c: ToolCall<"thread_delegate">) =>
        specs.thread_delegate.output.parse(await p.thread_delegate(c)),
      {
        authorize: async (c: ToolCall<"thread_delegate">) => {
          await p.prepareDelegation(c);
        },
      },
    ),
    thread_message: async (c) => specs.thread_message.output.parse(await p.thread_message(c)),
    thread_write: async (c) => specs.thread_write.output.parse(await p.thread_write(c)),
    assignment_cancel: async (c) =>
      specs.assignment_cancel.output.parse(await p.assignment_cancel(c)),
    person_message: async (c) => specs.person_message.output.parse(await p.person_message(c)),
    person_show: Object.assign(
      async (c: ToolCall<"person_show">) => specs.person_show.output.parse(await p.person_show(c)),
      {
        authorize: async (c: ToolCall<"person_show">) => {
          await p.preparePersonShow(c);
        },
      },
    ),
    request_list: async (c) => specs.request_list.output.parse(await p.request_list(c)),
    request_withdraw: async (c) => specs.request_withdraw.output.parse(await p.request_withdraw(c)),
    browser_profile_create: async (c) =>
      specs.browser_profile_create.output.parse(await p.browser_profile_create(c)),
    browser_profile_list: async (c) =>
      specs.browser_profile_list.output.parse(await p.browser_profile_list(c)),
    sign_in: async (c) => specs.sign_in.output.parse(await p.sign_in(c)),
    browser_access_request: async (c) =>
      specs.browser_access_request.output.parse(await p.browser_access_request(c)),
    machine_full_disk_access_request: async (c) =>
      specs.machine_full_disk_access_request.output.parse(
        await p.machine_full_disk_access_request(c),
      ),
    browser_tab_read: async (c) => specs.browser_tab_read.output.parse(await p.browser_tab_read(c)),
    browser_tab_write: async (c) =>
      specs.browser_tab_write.output.parse(await p.browser_tab_write(c)),
    browser_session_list: async (c) =>
      specs.browser_session_list.output.parse(await p.browser_session_list(c)),
    browser_session_open: async (c) =>
      specs.browser_session_open.output.parse(await p.browser_session_open(c)),
    browser_session_close: async (c) =>
      specs.browser_session_close.output.parse(await p.browser_session_close(c)),
    trigger_read: async (c) => specs.trigger_read.output.parse(await t.trigger_read(c)),
    trigger_write: async (c) => specs.trigger_write.output.parse(await t.trigger_write(c)),
    integration_search: async (c) =>
      specs.integration_search.output.parse(await i.integration_search(c)),
    integration_describe: async (c) =>
      specs.integration_describe.output.parse(await i.integration_describe(c)),
    integration_call: Object.assign(
      async (c: ToolCall<"integration_call">) =>
        specs.integration_call.output.parse(await i.integration_call(c)),
      {
        authorize: async (c: ToolCall<"integration_call">) => {
          await i.authorizeCall(c);
        },
      },
    ),
    computer: async (c) => specs.computer.output.parse(await i.computer(c)),
    integration_request: async (c) =>
      specs.integration_request.output.parse(await i.integration_request(c)),
    integration_propose: async (c) =>
      specs.integration_propose.output.parse(await i.integration_propose(c)),
  };
  // These domains commit an idempotency receipt with their effect, so a lost
  // outer result can be recovered by replaying the same domain operation.
  for (const handler of [
    handlers.person_message,
    handlers.thread_delegate,
    handlers.thread_message,
    handlers.thread_write,
    handlers.assignment_cancel,
    handlers.project_create,
  ]) {
    Object.assign(handler, { recover: handler });
  }
  return handlers;
}
