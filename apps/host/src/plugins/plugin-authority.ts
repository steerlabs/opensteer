// Check current authority at admission and again at handover after a long wait.
// Setting changes never wait on plugin work. Work already handed over may finish.

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { pluginOwnerId } from "./engine-protocol.js";
import { OpensteerError, type UserId } from "@opensteer/core";
import { PluginAgentStore, TriggerStore, type OpensteerStore } from "@opensteer/database";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { PluginAuthorization, PluginCaller } from "./engine-protocol.js";

const discovery = new Set([
  "catalogList",
  "catalogDetail",
  "resourcesRead",
  "list",
  "search",
  "describe",
  "listApps",
  "listAccounts",
  "listTools",
  "searchableTools",
  "searchTools",
  "grant",
  "skills",
  "listSkills",
  "readSkill",
]);
const management = new Set([
  "install",
  "export",
  "activate",
  "remove",
  "resourcesUpdate",
  "resourcesStop",
]);
const personOnly = new Set([
  "installed",
  "scheduleApprovals",
  "pinOAuth",
  "prepareOAuth",
  "oauthMethods",
  "startOAuth",
  "completeOAuth",
  "cancelOAuth",
  "oauthStatus",
  "saveOAuthApp",
  "removeOAuthApp",
  "createApiKeyAccount",
  "removeAccount",
  "reviewAccountLink",
  "linkAccount",
  "unlinkAccount",
  "manage",
  "page",
  "webhook",
  "accounts",
  "detail",
  "detailSection",
  "versions",
  "skillFiles",
]);
export function pluginCaller(caller: AgentCaller): PluginCaller {
  const subject =
    caller.kind === "run"
      ? ["task", caller.thread.id]
      : caller.kind === "program"
        ? [caller.program.kind, caller.key]
        : ["connection", caller.connectionId];
  return {
    caller: `agent:${JSON.stringify([caller.userId, ...subject])}`,
    mode: caller.accessMode === "auto" || caller.accessMode === "full-access" ? "automatic" : "ask",
  };
}
interface CallerScope {
  context: PluginCaller;
  caller: AgentCaller;
  execution?: string;
  plugins: Set<string>;
}

export class PluginAuthority {
  readonly #scope = new AsyncLocalStorage<CallerScope>();
  readonly #callers = new Map<string, CallerScope>();
  readonly options: {
    store: OpensteerStore;
    settings: PluginAgentStore;
    owner: () => Promise<UserId>;
    beforeAuthorize?: () => Promise<void>;
  };
  constructor(options: PluginAuthority["options"]) {
    this.options = options;
  }
  async scoped<T>(caller: AgentCaller, work: () => Promise<T>): Promise<T> {
    const subject = pluginCaller(caller);
    const context = { ...subject, caller: `${subject.caller}:${randomUUID()}` };
    const scope: CallerScope = { context, caller, plugins: new Set() };
    this.#callers.set(context.caller, scope);
    try {
      return await this.#scope.run(scope, work);
    } finally {
      if (!scope.execution) this.#callers.delete(context.caller);
    }
  }
  admit(caller: AgentCaller) {
    return this.#scope.getStore()?.context ?? pluginCaller(caller);
  }
  submittedExecution() {
    return this.#scope.getStore()?.execution;
  }
  execution(id: string, key: string, live: boolean) {
    const scope = this.#callers.get(key);
    if (!scope) return;
    if (live) scope.execution = id;
    else this.#callers.delete(key);
  }
  transfer(key: string, caller: AgentCaller) {
    const scope = this.#callers.get(key);
    if (scope) scope.caller = caller;
  }
  executionsFor(plugin: string) {
    return [...this.#callers.values()].flatMap(({ execution, plugins }) =>
      execution && plugins.has(plugin) ? [execution] : [],
    );
  }
  caller(key: string) {
    return this.#callers.get(key)?.caller;
  }
  async currentMode(key: string): Promise<PluginCaller["mode"]> {
    const caller = this.caller(key);
    if (!caller || caller.kind === "connection") return "ask";
    const thread = await this.options.store.getThreadForOwner(
      caller.kind === "run" ? caller.thread.id : caller.anchor.id,
      caller.userId,
    );
    return thread && (thread.accessMode === "auto" || thread.accessMode === "full-access")
      ? "automatic"
      : "ask";
  }
  async authorize(
    input: PluginAuthorization,
    signal?: AbortSignal,
  ): Promise<import("./engine-protocol.js").PluginAuthorizationResult> {
    const scope = this.#callers.get(input.caller);
    if (
      scope &&
      input.execution &&
      scope.execution === input.execution &&
      input.plugin &&
      !discovery.has(input.operation)
    )
      scope.plugins.add(input.plugin);
    const owner = await this.options.owner();
    if (input.operation === "cancel" && input.execution) {
      const execution = await this.options.settings.execution(input.execution);
      return { allowed: execution?.ownerUserId === owner && execution.caller === input.caller };
    }
    if (input.execution) await this.options.beforeAuthorize?.();
    signal?.throwIfAborted();
    const settings = await this.options.settings.settings(owner);
    const grants = Object.fromEntries(settings.map((s) => [s.pluginId, s.access]));
    if (input.plugin && input.write && (grants[input.plugin] ?? "all") !== "all")
      return { allowed: false, grants };
    if (input.caller === pluginOwnerId) {
      const access = input.plugin ? (grants[input.plugin] ?? "all") : "all";
      return {
        allowed:
          input.operation === "background"
            ? access === "all"
            : !["resolve", "page", "webhook"].includes(input.operation) || access !== "off",
        ...(input.operation === "background" ? { grants } : {}),
      };
    }
    const caller = scope?.caller;
    if (!caller || caller.userId !== owner) return { allowed: false };
    if (caller.kind === "program" && input.operation !== "cancel") {
      const triggers = new TriggerStore(this.options.store.database);
      try {
        if (caller.program.kind === "trigger")
          await triggers.assertActiveExecutionBinding(caller.program);
        else await triggers.assertActiveWatchBinding(caller.program);
      } catch {
        return { allowed: false };
      }
    }
    // Integration discovery/calls already use the personal owner's task authority, including team-bound tasks.
    if (caller.kind !== "connection") {
      const thread = await this.options.store.getThreadForOwner(
        caller.kind === "run" ? caller.thread.id : caller.anchor.id,
        owner,
      );
      if (!thread) return { allowed: false };
      if (
        input.mode === "automatic" &&
        !discovery.has(input.operation) &&
        thread.accessMode !== "auto" &&
        thread.accessMode !== "full-access"
      )
        return { allowed: false };
      const execution = input.execution
        ? await this.options.settings.execution(input.execution)
        : undefined;
      if (
        input.execution &&
        (!execution ||
          execution.ownerUserId !== owner ||
          execution.caller !== input.caller ||
          execution.mode !== input.mode ||
          (caller.kind === "run" && execution.runId !== caller.claims.runId) ||
          ["completed", "cancelled", "expired", "interrupted", "failed"].includes(execution.state))
      )
        return { allowed: false };
      if (caller.kind === "run" && input.operation !== "cancel") {
        if (!execution?.handoff) {
          try {
            await this.options.store.assertActiveGrant(caller.claims);
          } catch {
            return { allowed: false };
          }
        }
      }
      if (
        management.has(input.operation) &&
        (caller.kind !== "run" || thread.accessMode !== "full-access")
      )
        return { allowed: false };
    } else {
      const live = await this.options.store.database
        .selectFrom("agentConnections")
        .select("id")
        .where("id", "=", caller.connectionId)
        .where("userId", "=", owner)
        .where("revokedAt", "is", null)
        .where("tokenHash", "is not", null)
        .where("expiresAt", ">", new Date())
        .executeTakeFirst();
      if (!live || !discovery.has(input.operation)) return { allowed: false };
    }
    if (personOnly.has(input.operation)) return { allowed: false };
    if (
      input.plugin &&
      ((grants[input.plugin] === "off" &&
        !["cancel", "resourcesStop", "resourcesRead"].includes(input.operation)) ||
        (input.operation === "resourcesUpdate" && (grants[input.plugin] ?? "all") !== "all"))
    )
      return { allowed: false, grants };
    signal?.throwIfAborted();
    return { allowed: true, grants };
  }
  async assert(context: PluginCaller, operation: string, plugin?: string, execution?: string) {
    if (
      !(
        await this.authorize({
          ...context,
          operation,
          ...(plugin ? { plugin } : {}),
          ...(execution ? { execution } : {}),
        })
      ).allowed
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Plugin operation is unavailable to this caller.",
        next: "Continue with the access currently available; the person controls plugin access.",
      });
  }
}
