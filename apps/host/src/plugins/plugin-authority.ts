// Check current authority at admission and again at handover after a long wait.
// Setting changes never wait on plugin work. Work already handed over may finish.

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { pluginOwnerId } from "./engine-protocol.js";
import {
  OpensteerError,
  agentGrantAccess,
  type AgentGrantPluginTarget,
  type UserId,
} from "@opensteer/core";
import {
  executionDate,
  OpensteerStore,
  PluginAgentStore,
  TriggerStore,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Transaction } from "kysely";
import { callerLineage, type AgentCaller } from "../mcp/agent-caller.js";
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
// What an agent caller may ask for besides discovery and management. Anything unlisted is the
// person's alone, so a new engine operation is refused until it is added here on purpose.
const execution = new Set([
  "call",
  "callTool",
  "execute",
  "resume",
  "answer",
  "cancel",
  "executions",
  "resumeInvocation",
  "authorizeElicitation",
  "account-request",
  "subscribeEvent",
  "unsubscribeEvent",
  "findEventSubscription",
]);
export function pluginCaller(caller: AgentCaller): PluginCaller {
  const subject =
    caller.kind === "run"
      ? ["task", caller.thread.id]
      : caller.kind === "program"
        ? [caller.program.kind, caller.key]
        : ["connection", caller.connectionId];
  // Executions and their results belong to the lineage and grant revision that started them: a
  // narrowed or reconnected agent cannot resume or read work started under its earlier authority.
  const lineage = callerLineage(caller);
  return {
    caller: `agent:${JSON.stringify([
      caller.userId,
      ...subject,
      ...(lineage ? [lineage.agentConnectionId, lineage.revision] : []),
    ])}`,
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
    const mode = await this.#mode(this.options.store, caller).catch(() => null);
    return mode === "auto" || mode === "full-access" ? "automatic" : "ask";
  }
  /** The task's current mode, lowered to every mode in a connection lineage. */
  async #mode(store: OpensteerStore, caller: Exclude<AgentCaller, { kind: "connection" }>) {
    const thread = await store.getThreadForOwner(
      caller.kind === "run" ? caller.thread.id : caller.anchor.id,
      caller.userId,
    );
    if (!thread) return null;
    if (!caller.agentConnection) return thread.accessMode;
    return (
      await store.admitExecution({
        ownerUserId: caller.userId,
        subject: { kind: "binding", bindingId: caller.key },
      })
    ).mode;
  }
  /**
   * A selected grant reaches only the plugins and accounts it names, at the access it names;
   * anything else reads as Off. Rechecked from the live connection at every authorization.
   */
  async #grantCeiling(store: OpensteerStore, caller: AgentCaller) {
    const lineage = callerLineage(caller);
    if (!lineage) return null;
    const live = await store
      .admitExecution({
        ownerUserId: caller.userId,
        subject:
          caller.kind === "connection"
            ? { kind: "connection", agentConnectionId: caller.connectionId }
            : { kind: "binding", bindingId: caller.key },
      })
      .catch(() => undefined);
    // A changed revision is new authority: the call is refused, never reinterpreted.
    if (!live?.agentConnection || live.agentConnection.grantRevision !== lineage.revision)
      return undefined;
    const grant = live.agentConnection.grant;
    if (grant.scope === "everything") return null;
    return {
      visible: grant.resources.flatMap((resource) =>
        resource.kind !== "plugin"
          ? []
          : [
              resource.target.kind === "installed"
                ? resource.target.pluginId
                : resource.target.kind === "local-server"
                  ? `app_server_${resource.target.serverId}`
                  : `app_device_${resource.target.integrationConnectionId}`,
            ],
      ),
      access(plugin: string) {
        return agentGrantAccess(grant, { kind: "plugin", target: pluginGrantTarget(plugin) });
      },
      async grants(settings: Readonly<Record<string, "all" | "read-only" | "off">>) {
        const installed = await store.database.selectFrom("plugins").select("id").execute();
        return Object.fromEntries(
          [...new Set([...installed.map(({ id }) => id), ...Object.keys(settings)])].map((id) => {
            const access = this.access(id);
            const held = settings[id] ?? "all";
            return [
              id,
              access === null || held === "off"
                ? "off"
                : access === "read" || held === "read-only"
                  ? "read-only"
                  : held,
            ] as const;
          }),
        );
      },
    };
  }
  async authorize(
    input: PluginAuthorization,
    signal?: AbortSignal,
    handoff?: Transaction<DatabaseSchema>,
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
    // The first authorization waits for the engine's execution report. At
    // dispatch we already have that report and only reread committed authority.
    const owner = handoff ? scope?.caller.userId : await this.options.owner();
    if (!owner) return { allowed: false };
    const settingsStore = handoff ? new PluginAgentStore(handoff) : this.options.settings;
    if (input.operation === "cancel" && input.execution) {
      const execution = await settingsStore.execution(input.execution);
      return { allowed: execution?.ownerUserId === owner && execution.caller === input.caller };
    }
    if (input.execution && !handoff) await this.options.beforeAuthorize?.();
    signal?.throwIfAborted();
    const settings = await settingsStore.settings(owner);
    let grants: Record<string, "all" | "read-only" | "off"> = Object.fromEntries(
      settings.map((s) => [s.pluginId, s.access]),
    );
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
    const store = handoff
      ? new OpensteerStore(handoff, {
          executionClock: { now: () => executionDate(this.options.store.database).getTime() },
        })
      : this.options.store;
    if (
      !discovery.has(input.operation) &&
      !management.has(input.operation) &&
      !execution.has(input.operation)
    )
      return { allowed: false };
    const ceiling = await this.#grantCeiling(store, caller);
    if (ceiling === undefined) return { allowed: false };
    if (ceiling) {
      if (management.has(input.operation)) return { allowed: false };
      if (input.plugin && input.operation !== "cancel") {
        const access = ceiling.access(input.plugin);
        if (access === null || (input.write && access !== "read-write")) return { allowed: false };
      }
      grants = await ceiling.grants(grants);
    }
    if (caller.kind === "program" && input.operation !== "cancel") {
      const triggers = new TriggerStore(store.database);
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
      const mode = await this.#mode(store, caller).catch(() => null);
      if (!mode) return { allowed: false };
      if (
        input.mode === "automatic" &&
        !discovery.has(input.operation) &&
        mode !== "auto" &&
        mode !== "full-access"
      )
        return { allowed: false };
      const execution = input.execution
        ? await settingsStore.execution(input.execution)
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
            await store.assertActiveGrant(caller.claims);
          } catch {
            return { allowed: false };
          }
        }
      }
      if (management.has(input.operation) && (caller.kind !== "run" || mode !== "full-access"))
        return { allowed: false };
    } else {
      const live = await store.database
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
    if (
      input.plugin &&
      ((grants[input.plugin] === "off" &&
        !discovery.has(input.operation) &&
        !["cancel", "resourcesStop", "resourcesRead"].includes(input.operation)) ||
        (input.operation === "resourcesUpdate" && (grants[input.plugin] ?? "all") !== "all"))
    )
      return { allowed: false, grants };
    signal?.throwIfAborted();
    return { allowed: true, grants, ...(ceiling ? { visible: ceiling.visible } : {}) };
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

/** The grant identity of an engine app id: a local server, a device account, or a plugin. */
export function pluginGrantTarget(plugin: string): AgentGrantPluginTarget {
  if (plugin.startsWith("app_server_"))
    return { kind: "local-server", serverId: plugin.slice("app_server_".length) };
  if (plugin.startsWith("app_device_"))
    return { kind: "device-account", integrationConnectionId: plugin.slice("app_device_".length) };
  return { kind: "installed", pluginId: plugin };
}
