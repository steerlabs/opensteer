import { type Tab, type ThreadId } from "@opensteer/core";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type {
  AgentSessionService,
  DirectOperationContext,
} from "../../agent-sessions/agent-session-service.js";
import { lentDevice, lentNow, type LendingReader } from "../lent-now.js";
import type { TabActor, TabServicePort } from "../../tabs/ports.js";
import { callerLineage, type AgentCaller } from "../agent-caller.js";
import { operationId } from "../operations.js";
import { directResult as direct, requireDirectWork } from "./direct.js";
import type { ToolCall } from "./types.js";

function actor(caller: AgentCaller): TabActor {
  if (caller.kind === "run") return { kind: "run", claims: caller.claims };
  if (caller.kind === "connection") return { kind: "connection", caller };
  return {
    kind: "browser-binding",
    authority: { agentBindingId: caller.key, ownerId: caller.userId },
    threadId: caller.anchor.id,
  };
}
/** A connected agent's session acting on tabs: attributed to its task, stopped with it. */
function sessionActor(context: DirectOperationContext): TabActor {
  return {
    kind: "browser-binding",
    authority: { agentBindingId: context.bindingId, ownerId: context.ownerUserId },
    threadId: context.taskId,
    signal: context.signal,
  };
}
function tabForCaller(visible: (deviceId: string) => boolean, tab: Tab) {
  const { computer, ...rest } = tab;
  return visible(computer.computerId) ? tab : rest;
}

export class TabToolHandlers {
  readonly #tabs: TabServicePort;
  readonly #sessions: AgentSessionService | undefined;
  readonly #lending: LendingReader | undefined;
  constructor(tabs: TabServicePort, sessions?: AgentSessionService, lending?: LendingReader) {
    this.#tabs = tabs;
    this.#sessions = sessions;
    this.#lending = lending;
  }
  /**
   * The person's Devices a tab may name to this caller: of what its connection lineage is lent
   * now. Without the rule to read, a selected grant learns of none.
   */
  async #visible(caller: AgentCaller): Promise<(deviceId: string) => boolean> {
    if (this.#lending) return lentDevice(await lentNow(caller, this.#lending));
    return callerLineage(caller)?.grant.scope === "selected" ? () => false : () => true;
  }

  async tab_list({
    caller,
    input,
    operationKey,
    discoveryInput,
    discoveryTab,
  }: ToolCall<"tab_list">) {
    const { taskId, reason, operationKey: _key, operationId: _id, ...filters } = input;
    const list = async (tabActor: TabActor) => {
      const visible = await this.#visible(caller);
      const result = await this.#tabs.list(tabActor, filters, visible, discoveryTab);
      return { ...result, tabs: result.tabs.map((tab) => tabForCaller(visible, tab)) };
    };
    if (caller.kind !== "connection") return list(actor(caller));
    return direct(
      await requireDirectWork(this.#sessions).run({
        ownerUserId: caller.userId,
        agentConnectionId: caller.connectionId,
        taskId: taskId as ThreadId | undefined,
        reason,
        operationKey,
        tool: "tab_list",
        input: discoveryInput ? { discovery: discoveryInput, read: input } : input,
        ...(discoveryInput ? { reportReplay: true } : {}),
        target: null,
        targetName: "Your tabs",
        effect: "read",
        calls: `tab_list ${canonicalJson(filters)}`,
        execute: (context) => list(sessionActor(context)),
        summarize: (result) => ({ tabs: result.tabs.length }),
      }),
    );
  }
  async tab_open({ caller, input, operationKey }: ToolCall<"tab_open">) {
    const { tab } = await this.#tabs.open(
      actor(caller),
      input.target,
      operationId(caller, operationKey, "tab_open"),
    );
    return { tab: tabForCaller(await this.#visible(caller), tab) };
  }
  async tab_close({ caller, input, operationKey }: ToolCall<"tab_close">) {
    return this.#tabs.close(
      actor(caller),
      input.tabIds,
      operationId(caller, operationKey, "tab_close"),
    );
  }
  async tab_organize({ caller, input, operationKey }: ToolCall<"tab_organize">) {
    return this.#tabs.organize(
      actor(caller),
      input,
      operationId(caller, operationKey, "tab_organize"),
    );
  }
  async tab_group_update({ caller, input, operationKey }: ToolCall<"tab_group_update">) {
    return this.#tabs.updateGroup(
      actor(caller),
      input,
      operationId(caller, operationKey, "tab_group_update"),
    );
  }
}
