import { OpensteerError, type UserId } from "@opensteer/core";
import { PluginAgentStore, TriggerStore, type OpensteerStore } from "@opensteer/database";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { PluginAuthorization, PluginCaller } from "./engine-protocol.js";

const discovery = new Set([
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
const management = new Set(["install", "export", "activate", "remove"]);
const personOnly = new Set([
  "installed",
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
  async authorize(input: PluginAuthorization) {
    await this.options.beforeAuthorize?.();
    const owner = await this.options.owner();
    const settings = await this.options.settings.settings(owner);
    const grants = Object.fromEntries(settings.map((s) => [s.pluginId, s.access]));
    if (input.caller === "personal") {
      const access = input.plugin ? (grants[input.plugin] ?? "all") : "all";
      return {
        allowed: input.operation !== "background" || access !== "off",
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
      if (caller.kind === "run" && input.operation !== "cancel") {
        const execution = input.execution
          ? await this.options.settings.execution(input.execution)
          : undefined;
        if (input.execution && !execution) return { allowed: false };
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
    if (input.plugin && grants[input.plugin] === "off" && input.operation !== "cancel")
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
