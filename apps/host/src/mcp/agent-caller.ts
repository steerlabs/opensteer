import {
  OpensteerError,
  threadReachScope,
  type Thread,
  type ThreadAccessMode,
  type ThreadReachScope,
  type UserId,
  type ProjectAuthority,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { ProjectCapabilityScope } from "@opensteer/protocol";
import type { RunToolScope, RunToolTokenService } from "../agents/run-tool-tokens.js";
import { isProjectRunCapabilityEnvelope } from "../agents/run-capability.js";
import type {
  TriggerControlScope,
  TriggerControlTokenService,
} from "../triggers/trigger-control-service.js";
import type { WatchControlScope, WatchControlTokenService } from "../triggers/watch-capability.js";

export interface AgentCallerBase {
  readonly key: string;
  readonly accessMode: ThreadAccessMode;
  readonly reach: ThreadReachScope;
}
export interface HumanAgentCallerBase extends AgentCallerBase {
  readonly userId: UserId;
}
export interface ProjectCaller extends AgentCallerBase {
  readonly kind: "project";
  readonly principal: ProjectAuthority["principal"];
  readonly origin: ProjectAuthority["origin"];
  readonly reach: Extract<ThreadReachScope, { kind: "workspace" }>;
  readonly thread: Thread;
  readonly claims: ProjectCapabilityScope;
}
export interface RunCaller extends HumanAgentCallerBase {
  readonly kind: "run";
  readonly thread: Thread;
  readonly claims: RunToolScope;
}
export interface ProgramCaller extends HumanAgentCallerBase {
  readonly kind: "program";
  readonly anchor: Thread;
  readonly program:
    | ({ readonly kind: "trigger" } & TriggerControlScope)
    | ({ readonly kind: "watch" } & WatchControlScope);
}
export interface ConnectionCaller extends HumanAgentCallerBase {
  readonly kind: "connection";
  readonly connectionId: string;
}
export type AgentCaller = RunCaller | ProgramCaller | ConnectionCaller;

/** Connected agents' MCP-only credentials; browser and Runner credentials are never tried. */
export interface ConnectionAuthenticator {
  authenticate(bearer: string): Promise<{
    readonly connectionId: string;
    readonly userId: UserId;
    readonly accessMode: ThreadAccessMode;
    readonly reach: ThreadReachScope;
  }>;
}

export class AgentCallerResolver {
  readonly options: {
    readonly store: Pick<OpensteerStore, "getThreadForOwner" | "workspaceMembershipForUser">;
    readonly runs: Pick<RunToolTokenService, "authenticate">;
    readonly triggers?: Pick<TriggerControlTokenService, "authenticate">;
    readonly watches?: Pick<WatchControlTokenService, "authenticate">;
    readonly connections?: ConnectionAuthenticator;
  };
  constructor(options: {
    readonly store: Pick<OpensteerStore, "getThreadForOwner" | "workspaceMembershipForUser">;
    readonly runs: Pick<RunToolTokenService, "authenticate">;
    readonly triggers?: Pick<TriggerControlTokenService, "authenticate">;
    readonly watches?: Pick<WatchControlTokenService, "authenticate">;
    readonly connections?: ConnectionAuthenticator;
  }) {
    this.options = options;
  }
  async authenticate(bearer: string): Promise<AgentCaller> {
    // Unverified routing can only refuse; this resolver authenticates human capabilities.
    if (Buffer.byteLength(bearer, "utf8") > 64 * 1024 || isProjectRunCapabilityEnvelope(bearer))
      throw unavailable();
    // Only token validation selects a credential family. A valid token whose live
    // anchor fails must never fall through to another family's authenticator.
    const run = await this.options.runs.authenticate(bearer).catch(() => null);
    if (run) {
      const thread = await this.#anchor(
        run.threadId,
        run.requestedBy,
        run.workspaceId,
        run.environmentId,
      );
      const reach = threadReachScope(thread);
      if (reach.kind === "user") {
        const root =
          thread.lineageRootThreadId === thread.id
            ? thread
            : await this.options.store.getThreadForOwner(
                thread.lineageRootThreadId,
                run.requestedBy,
              );
        if (!root) throw unavailable();
        const membership = await this.options.store.workspaceMembershipForUser(
          root.workspaceId,
          run.requestedBy,
        );
        if (!membership || membership.state !== "active" || membership.role !== "owner")
          throw unavailable();
      }
      return {
        kind: "run",
        key: `run:${run.runId}`,
        userId: run.requestedBy,
        accessMode: thread.accessMode,
        reach,
        thread,
        claims: run,
      };
    }
    const trigger = await this.options.triggers?.authenticate(bearer).catch(() => null);
    if (trigger) {
      const anchor = await this.#anchor(
        trigger.threadId,
        trigger.requestedBy,
        trigger.workspaceId,
        trigger.environmentId,
      );
      return {
        kind: "program",
        key: `trigger:${trigger.occurrenceId}`,
        userId: trigger.requestedBy,
        accessMode: anchor.accessMode,
        reach: threadReachScope(anchor),
        anchor,
        program: { ...trigger, kind: "trigger" },
      };
    }
    const watch = await this.options.watches?.authenticate(bearer).catch(() => null);
    if (watch) {
      const anchor = await this.#anchor(
        watch.anchorThreadId,
        watch.createdBy,
        watch.workspaceId,
        watch.environmentId,
      );
      return {
        kind: "program",
        key: `watch:${watch.activationId}`,
        userId: watch.createdBy,
        accessMode: anchor.accessMode,
        reach: threadReachScope(anchor),
        anchor,
        program: { ...watch, kind: "watch" },
      };
    }
    if (this.options.connections) {
      const connection = await this.options.connections.authenticate(bearer);
      return { ...connection, key: `connection:${connection.connectionId}`, kind: "connection" };
    }
    throw unavailable();
  }
  async #anchor(
    id: Thread["id"],
    owner: UserId,
    workspaceId: Thread["workspaceId"],
    environmentId: Thread["environmentId"],
  ): Promise<Thread> {
    const anchor = await this.options.store.getThreadForOwner(id, owner);
    if (!anchor || anchor.workspaceId !== workspaceId || anchor.environmentId !== environmentId)
      throw unavailable();
    return anchor;
  }
}
export function callerThread(caller: AgentCaller): Thread {
  if (caller.kind === "connection") throw unavailable();
  return caller.kind === "run" ? caller.thread : caller.anchor;
}
function unavailable() {
  return new OpensteerError({
    code: "forbidden",
    message: "MCP caller authority is unavailable or expired",
  });
}
