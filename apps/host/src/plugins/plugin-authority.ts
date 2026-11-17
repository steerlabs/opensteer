import { randomUUID } from "node:crypto";
import { acquireTaskPluginAdmission, pluginAdmissionKey } from "@opensteer/database";
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
export class PluginAuthority {
  readonly #active = new Map<string, number>();
  readonly #executions = new Map<string, string>();
  async scoped<T>(caller: AgentCaller, work: () => Promise<T>): Promise<T> {
    const key = this.admit(caller).caller;
    this.#active.set(key, (this.#active.get(key) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const count = (this.#active.get(key) ?? 1) - 1;
      if (count) this.#active.set(key, count);
      else this.#active.delete(key);
      this.#retire(key);
    }
  }
  execution(id: string, caller: string, live: boolean) {
    if (live) this.#executions.set(id, caller);
    else this.#executions.delete(id);
    this.#retire(caller);
  }
  #retire(key: string) {
    if (!this.#active.has(key) && ![...this.#executions.values()].includes(key))
      this.#callers.delete(key);
  }
  readonly #leases = new Map<string, { caller: string; release: () => void }>();
  readonly #callers = new Map<string, AgentCaller>();
  readonly options: {
    store: OpensteerStore;
    settings: PluginAgentStore;
    owner: () => Promise<UserId>;
    beforeAuthorize?: () => Promise<void>;
  };
  constructor(options: PluginAuthority["options"]) {
    this.options = options;
  }
  admit(caller: AgentCaller) {
    const context = pluginCaller(caller);
    this.#callers.set(context.caller, caller);
    return context;
  }
  caller(key: string) {
    return this.#callers.get(key);
  }
  async currentMode(key: string): Promise<PluginCaller["mode"]> {
    const caller = this.#callers.get(key);
    if (!caller || caller.kind === "connection" || pluginCaller(caller).mode === "ask")
      return "ask";
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
    if (input.lease) {
      const lease = this.#leases.get(input.lease);
      if (lease?.caller !== input.caller) return { allowed: false };
      lease.release();
      this.#leases.delete(input.lease);
      return { allowed: true };
    }
    if (input.admission) {
      const caller = this.#callers.get(input.caller);
      const releaseTask =
        caller && caller.kind !== "connection"
          ? await acquireTaskPluginAdmission(
              this.options.store.database,
              caller.kind === "run" ? caller.thread.id : caller.anchor.id,
            )
          : () => {};
      let releasePlugin = () => {};
      let abort: (() => void) | undefined;
      const release = () => {
        if (abort) signal?.removeEventListener("abort", abort);
        releasePlugin();
        releaseTask();
      };
      try {
        if (input.plugin)
          releasePlugin = await acquireTaskPluginAdmission(
            this.options.store.database,
            pluginAdmissionKey(await this.options.owner(), input.plugin),
          );
        signal?.throwIfAborted();
        const permission = await this.authorize({ ...input, admission: false }, signal);
        signal?.throwIfAborted();
        if (!permission.allowed) {
          release();
          return permission;
        }
        const lease = randomUUID();
        this.#leases.set(lease, { caller: input.caller, release });
        abort = () => {
          release();
          this.#leases.delete(lease);
        };
        signal?.addEventListener("abort", abort, { once: true });
        return { ...permission, lease };
      } catch (error) {
        release();
        throw error;
      }
    }
    await this.options.beforeAuthorize?.();
    const owner = await this.options.owner();
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
    if (input.operation === "cancel" && input.execution) {
      const execution = await this.options.settings.execution(input.execution);
      return {
        allowed: execution?.ownerUserId === owner && execution.caller === input.caller,
        grants,
      };
    }
    const caller = this.#callers.get(input.caller);
    if (!caller || caller.userId !== owner) return { allowed: false };
    if (
      input.mode === "automatic" &&
      input.operation !== "cancel" &&
      !discovery.has(input.operation) &&
      (await this.currentMode(input.caller)) !== "automatic"
    )
      return { allowed: false };
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
      const execution = input.execution
        ? await this.options.settings.execution(input.execution)
        : undefined;
      if (
        input.execution &&
        (!execution ||
          execution.ownerUserId !== owner ||
          execution.caller !== input.caller ||
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
    if (caller.kind === "program" && management.has(input.operation)) return { allowed: false };
    if (
      input.plugin &&
      ((grants[input.plugin] === "off" &&
        !["cancel", "resourcesStop", "resourcesRead"].includes(input.operation)) ||
        (input.operation === "resourcesUpdate" && (grants[input.plugin] ?? "all") !== "all"))
    )
      return { allowed: false, grants };
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
