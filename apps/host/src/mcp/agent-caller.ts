import { OpensteerError, type Thread, type ThreadAccessMode, type UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunToolScope, RunToolTokenService } from "../agents/run-tool-tokens.js";
import type {
  TriggerControlScope,
  TriggerControlTokenService,
} from "../triggers/trigger-control-service.js";
import type { WatchControlScope, WatchControlTokenService } from "../triggers/watch-capability.js";

export interface AgentCallerBase {
  readonly key: string;
  readonly userId: UserId;
  readonly accessMode: ThreadAccessMode;
}
export interface RunCaller extends AgentCallerBase {
  readonly kind: "run";
  readonly thread: Thread;
  readonly claims: RunToolScope;
}
export interface ProgramCaller extends AgentCallerBase {
  readonly kind: "program";
  readonly anchor: Thread;
  readonly program:
    | ({ readonly kind: "trigger" } & TriggerControlScope)
    | ({ readonly kind: "watch" } & WatchControlScope);
}
export interface ConnectionCaller extends AgentCallerBase {
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
  }>;
}

export class AgentCallerResolver {
  readonly options: {
    readonly store: Pick<OpensteerStore, "getThreadForOwner">;
    readonly runs: Pick<RunToolTokenService, "authenticate">;
    readonly triggers?: Pick<TriggerControlTokenService, "authenticate">;
    readonly watches?: Pick<WatchControlTokenService, "authenticate">;
    readonly connections?: ConnectionAuthenticator;
  };
  constructor(options: {
    readonly store: Pick<OpensteerStore, "getThreadForOwner">;
    readonly runs: Pick<RunToolTokenService, "authenticate">;
    readonly triggers?: Pick<TriggerControlTokenService, "authenticate">;
    readonly watches?: Pick<WatchControlTokenService, "authenticate">;
    readonly connections?: ConnectionAuthenticator;
  }) {
    this.options = options;
  }
  async authenticate(bearer: string): Promise<AgentCaller> {
    // Only token validation selects a credential family. A valid token whose live
    // anchor fails must never fall through to another family's authenticator.
    const run = await this.options.runs.authenticate(bearer).catch(() => null);
    if (run) {
      const thread = await this.#anchor(run.threadId, run.requestedBy, run.environmentId);
      return {
        kind: "run",
        key: `run:${run.runId}`,
        userId: run.requestedBy,
        accessMode: thread.accessMode,
        thread,
        claims: run,
      };
    }
    const trigger = await this.options.triggers?.authenticate(bearer).catch(() => null);
    if (trigger) {
      const anchor = await this.#anchor(
        trigger.threadId,
        trigger.requestedBy,
        trigger.environmentId,
      );
      return {
        kind: "program",
        key: `trigger:${trigger.occurrenceId}`,
        userId: trigger.requestedBy,
        accessMode: anchor.accessMode,
        anchor,
        program: { ...trigger, kind: "trigger" },
      };
    }
    const watch = await this.options.watches?.authenticate(bearer).catch(() => null);
    if (watch) {
      const anchor = await this.#anchor(watch.anchorThreadId, watch.createdBy, watch.environmentId);
      return {
        kind: "program",
        key: `watch:${watch.activationId}`,
        userId: watch.createdBy,
        accessMode: anchor.accessMode,
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
    environmentId: Thread["environmentId"],
  ): Promise<Thread> {
    const anchor = await this.options.store.getThreadForOwner(id, owner);
    if (!anchor || anchor.environmentId !== environmentId) throw unavailable();
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
