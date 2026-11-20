import {
  OpensteerError,
  agentGrantAccess,
  type AgentOperationTarget,
  type BrowserProfileId,
  type TabId,
  type ThreadId,
} from "@opensteer/core";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type {
  AgentSessionService,
  DirectOperationContext,
  DirectOperationResult,
} from "../../agent-sessions/agent-session-service.js";
import type { TabActor, TabServicePort } from "../../tabs/ports.js";
import type { AgentCaller, ConnectionCaller } from "../agent-caller.js";
import { operationId, requireRun } from "../operations.js";
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
/** The tool's own result beside what the direct call reports. */
function direct<Result extends object>(outcome: DirectOperationResult<Result>) {
  const { status, taskId, operationId } = outcome;
  return {
    ...(outcome.status === "completed" && outcome.result ? outcome.result : {}),
    status,
    taskId,
    operationId,
    ...(outcome.status === "pending" ? { requestId: outcome.requestId } : {}),
    ...(outcome.status === "completed" ? {} : { next: outcome.next }),
  };
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
    if (!this.#sessions)
      throw new OpensteerError({
        code: "conflict",
        message: "This Home does not run direct work for connected agents.",
      });
    return this.#sessions;
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
    if (caller.kind !== "connection") return this.#tabs.list(actor(caller), filters);
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
        execute: (context) => this.#tabs.list(sessionActor(context), filters),
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
          message: "A connected agent can open browser pages directly.",
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
          execute: (context) =>
            this.#tabs.open(sessionActor(context), target, `operation:${context.operationId}`),
          summarize: (result) => ({ tabId: result.tab.tabId }),
        }),
      );
    }
    requireRun(caller);
    return this.#tabs.open(
      actor(caller),
      input.target,
      operationId(caller, operationKey, "tab_open"),
    );
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
