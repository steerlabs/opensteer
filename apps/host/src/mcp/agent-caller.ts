import {
  OpensteerError,
  type AgentGrant,
  type Thread,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import type { AgentConnectionAuthority, OpensteerStore } from "@opensteer/database";
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
  /**
   * The connected agent this execution works for, as it stood when the call was authenticated;
   * every effect re-resolves it. Absent for the person's own work.
   */
  readonly agentConnection?: AgentConnectionAuthority;
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
  readonly grant: AgentGrant;
  readonly grantRevision: number;
  /** When the credential stops working, in epoch milliseconds. */
  readonly expiresAt?: number;
}
export type AgentCaller = RunCaller | ProgramCaller | ConnectionCaller;

/** Connected agents' MCP-only credentials; browser and Runner credentials are never tried. */
export interface ConnectionAuthenticator {
  authenticate(bearer: string): Promise<{
    readonly connectionId: string;
    readonly userId: UserId;
    readonly accessMode: ThreadAccessMode;
    readonly grant: AgentGrant;
    readonly grantRevision: number;
    readonly consentVersion: number;
    readonly expiresAt?: number;
  }>;
}

export class AgentCallerResolver {
  readonly options: {
    readonly store: Pick<
      OpensteerStore,
      "getThreadForOwner" | "admitExecution" | "bindingAgentConnectionId"
    >;
    readonly runs: Pick<RunToolTokenService, "authenticate">;
    readonly triggers?: Pick<TriggerControlTokenService, "authenticate">;
    readonly watches?: Pick<WatchControlTokenService, "authenticate">;
    readonly connections?: ConnectionAuthenticator;
  };
  constructor(options: {
    readonly store: Pick<
      OpensteerStore,
      "getThreadForOwner" | "admitExecution" | "bindingAgentConnectionId"
    >;
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
        ...(await this.#authority(run.requestedBy, `run:${run.runId}`, thread)),
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
        ...(await this.#authority(trigger.requestedBy, `trigger:${trigger.occurrenceId}`, anchor)),
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
        ...(await this.#authority(watch.createdBy, `watch:${watch.activationId}`, anchor)),
        anchor,
        program: { ...watch, kind: "watch" },
      };
    }
    if (this.options.connections) {
      const connection = await this.options.connections.authenticate(bearer);
      return {
        key: `connection:${connection.connectionId}`,
        kind: "connection",
        connectionId: connection.connectionId,
        userId: connection.userId,
        accessMode: connection.accessMode,
        grant: connection.grant,
        grantRevision: connection.grantRevision,
        ...(connection.expiresAt !== undefined ? { expiresAt: connection.expiresAt } : {}),
        agentConnection: {
          agentConnectionId: connection.connectionId,
          grant: connection.grant,
          grantRevision: connection.grantRevision,
          consentVersion: connection.consentVersion,
          accessMode: connection.accessMode,
        },
      };
    }
    throw unavailable();
  }
  /**
   * The person's own work keeps its task's current mode; work in a connection's lineage takes
   * the minimum of every mode in it, and ends with the connection.
   */
  async #authority(
    owner: UserId,
    bindingId: string,
    thread: Thread,
  ): Promise<{
    readonly accessMode: ThreadAccessMode;
    readonly agentConnection?: AgentConnectionAuthority;
  }> {
    // The person's own work pays one indexed read; only lineaged work resolves the full record.
    if (!(await this.options.store.bindingAgentConnectionId(bindingId)))
      return { accessMode: thread.accessMode };
    const authority = await this.options.store
      .admitExecution({ ownerUserId: owner, subject: { kind: "binding", bindingId } })
      .catch(() => {
        throw unavailable();
      });
    return authority.agentConnection
      ? { accessMode: authority.mode, agentConnection: authority.agentConnection }
      : { accessMode: thread.accessMode };
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
/** The connected agent a caller works for: itself, or the connection its lineage names. */
export function callerLineage(caller: AgentCaller): {
  readonly agentConnectionId: string;
  readonly grant: AgentGrant;
  readonly revision: number;
} | null {
  if (caller.kind === "connection")
    return {
      agentConnectionId: caller.connectionId,
      grant: caller.grant,
      revision: caller.grantRevision,
    };
  return caller.agentConnection
    ? {
        agentConnectionId: caller.agentConnection.agentConnectionId,
        grant: caller.agentConnection.grant,
        revision: caller.agentConnection.grantRevision,
      }
    : null;
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
