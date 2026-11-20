import {
  OpensteerError,
  agentGrantAccess,
  type AgentOperationTarget,
  type BrowserProfileId,
  type Tab,
  type TabId,
  type ThreadId,
} from "@opensteer/core";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type {
  AgentSessionService,
  DirectOperationContext,
} from "../../agent-sessions/agent-session-service.js";
import { deviceVisibleTo } from "../../devices/device-visibility.js";
import type { TabActor, TabServicePort } from "../../tabs/ports.js";
import { callerLineage, type AgentCaller, type ConnectionCaller } from "../agent-caller.js";
import { operationId, requireRun } from "../operations.js";
import { directResult as direct, requireDirectWork } from "./direct.js";
import type { ToolCall } from "./types.js";

function actor(caller: AgentCaller): TabActor {
  if (caller.kind === "run") return { kind: "run", claims: caller.claims };
  if (caller.kind === "connection") return { kind: "connection", caller };
  throw new OpensteerError({ code: "forbidden", message: "Programs cannot access tabs." });
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
function notFound(): never {
  throw new OpensteerError({ code: "not_found", message: "Tab not found." });
}

function tabForCaller(caller: AgentCaller, tab: Tab) {
  const { computer, ...rest } = tab;
  return deviceVisibleTo(callerLineage(caller)?.grant)(computer.computerId) ? tab : rest;
}

export class TabToolHandlers {
  readonly #tabs: TabServicePort;
  readonly #sessions: AgentSessionService | undefined;
  readonly #profileName: (
    caller: ConnectionCaller,
    profileId: BrowserProfileId,
  ) => Promise<string | null>;
  constructor(
    tabs: TabServicePort,
    sessions?: AgentSessionService,
    /** A granted profile's name, so the person sees what an operation touches. */
    profileName: (
      caller: ConnectionCaller,
      profileId: BrowserProfileId,
    ) => Promise<string | null> = async () => null,
  ) {
    this.#tabs = tabs;
    this.#sessions = sessions;
    this.#profileName = profileName;
  }
  #direct() {
    return requireDirectWork(this.#sessions);
  }
  async #profileTarget(
    caller: ConnectionCaller,
    profileId: BrowserProfileId | null,
  ): Promise<AgentOperationTarget> {
    if (!profileId) return { grant: { kind: "device" }, name: "Guest browser", device: null };
    // A name is resolved only for a profile the grant reaches; anything else stays unnamed.
    const granted = agentGrantAccess(caller.grant, { kind: "browser-profile", profileId });
    const name = granted ? await this.#profileName(caller, profileId) : null;
    return {
      grant: { kind: "browser-profile", profileId },
      name: name ?? "This browser profile",
      device: null,
    };
  }

  async tab_list({ caller, input, operationKey }: ToolCall<"tab_list">) {
    const { taskId, reason, operationKey: _key, ...filters } = input;
    const list = async (tabActor: TabActor) => {
      const result = await this.#tabs.list(
        tabActor,
        filters,
        deviceVisibleTo(callerLineage(caller)?.grant),
      );
      return { ...result, tabs: result.tabs.map((tab) => tabForCaller(caller, tab)) };
    };
    if (caller.kind !== "connection") return list(actor(caller));
    return direct(
      await this.#direct().run({
        ownerUserId: caller.userId,
        agentConnectionId: caller.connectionId,
        taskId: taskId as ThreadId | undefined,
        reason,
        operationKey,
        tool: "tab_list",
        input: filters,
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
    if (caller.kind === "connection") {
      const { taskId, reason, target } = input;
      const operationTarget = await this.#profileTarget(
        caller,
        target.kind === "page" && "profileId" in target ? target.profileId : null,
      );
      if (target.kind !== "page")
        throw new OpensteerError({
          code: "forbidden",
          message: "A connected agent can only open browser pages here. Pass target.kind = \"page\".",
        });
      return direct(
        await this.#direct().run({
          ownerUserId: caller.userId,
          agentConnectionId: caller.connectionId,
          taskId: taskId as ThreadId | undefined,
          reason,
          operationKey,
          tool: "tab_open",
          input: { target },
          target: operationTarget,
          effect: "write",
          calls: `tab_open ${canonicalJson({ target })}`,
          execute: async (context) => {
            const { tab } = await this.#tabs.open(
              sessionActor(context), target, `operation:${context.operationId}`,
            );
            return { tab: tabForCaller(caller, tab) };
          },
          summarize: (result) => ({ tabId: result.tab.tabId }),
        }),
      );
    }
    requireRun(caller);
    const { tab } = await this.#tabs.open(
      actor(caller),
      input.target,
      operationId(caller, operationKey, "tab_open"),
    );
    return { tab: tabForCaller(caller, tab) };
  }
  async tab_close({ caller, input, operationKey }: ToolCall<"tab_close">) {
    if (caller.kind === "connection") {
      const { taskId, reason, tabIds } = input;
      if (tabIds.length !== 1)
        throw new OpensteerError({
          code: "bad_request",
          message: "Close one tab per call, so each is reviewed on its own.",
        });
      const tabId = tabIds[0] as TabId;
      // Only a tab this connection can already see; anything else reads as unknown.
      const visible = await this.#tabs.list(actor(caller), {});
      const tab = visible.tabs.find((entry) => entry.tabId === tabId) ?? notFound();
      const profileId =
        "profile" in tab && tab.profile ? (tab.profile.profileId as BrowserProfileId) : null;
      return direct(
        await this.#direct().run({
          ownerUserId: caller.userId,
          agentConnectionId: caller.connectionId,
          taskId: taskId as ThreadId | undefined,
          reason,
          operationKey,
          tool: "tab_close",
          input: { tabIds },
          target: await this.#profileTarget(caller, profileId),
          targetGeneration: tabId,
          effect: "write",
          calls: `tab_close ${canonicalJson({ tabIds })}`,
          execute: (context) =>
            this.#tabs.close(sessionActor(context), [tabId], `operation:${context.operationId}`),
          summarize: (result) => ({ closed: result.closed.length, failed: result.failed.length }),
        }),
      );
    }
    requireRun(caller);
    return this.#tabs.close(
      actor(caller),
      input.tabIds,
      operationId(caller, operationKey, "tab_close"),
    );
  }
  async tab_organize({ caller, input, operationKey }: ToolCall<"tab_organize">) {
    requireRun(caller);
    return this.#tabs.organize(
      actor(caller),
      input,
      operationId(caller, operationKey, "tab_organize"),
    );
  }
  async tab_group_update({ caller, input, operationKey }: ToolCall<"tab_group_update">) {
    requireRun(caller);
    return this.#tabs.updateGroup(
      actor(caller),
      input,
      operationId(caller, operationKey, "tab_group_update"),
    );
  }
}
