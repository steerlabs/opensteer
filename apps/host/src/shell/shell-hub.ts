import { randomUUID } from "node:crypto";
import { OpensteerError, type RunId, type RunnerId, type UserId } from "@opensteer/core";
import type { OpensteerStore, RevokedRunGrant } from "@opensteer/database";
import type {
  RunnerAuxiliaryStream,
  RunnerRegistry,
  RunnerStreamLossReason,
} from "@opensteer/orchestration";
import {
  machineAccessMaxActiveSessions,
  machineAccessMaxRunSessions,
  sameRunnerAuxiliaryFence,
  shellAuditEventCap,
  ShellCloseReasonSchema,
  ShellSessionIdSchema,
  ShellSessionSummarySchema,
  type MachineAccessPolicy,
  type RunnerAuxiliaryFrameFence,
  type ShellAuditEvent,
  type ShellCloseReason,
  type ShellConnectErrorCode,
  type ShellModuleEvent,
  type ShellSessionAuthority,
  type ShellSessionId,
  type ShellSessionSummary,
} from "@opensteer/protocol";
import type {
  AgentControlRunScope,
  AgentControlTokenService,
} from "../agents/agent-control-service.js";
import type { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import type { MachineAccessNotifier } from "./machine-access-events.js";
import {
  pumpShellBytes,
  shellSocketOpen,
  type ShellByteSocket,
  type ShellPumpHandle,
} from "./shell-byte-pump.js";
import { describeMachineLastSeen, ShellConnectRejection } from "./shell-connect-error.js";
import type { ShellControlPeer, ShellControlStreamHandler } from "./shell-control-stream.js";

const defaultOpenTimeoutMs = 10_000;
/** How long a closing socket is given before it is taken away from its peer. */
const defaultTerminationDeadlineMs = 5_000;
const auditCommandMaxBytes = 4 * 1_024;
const auditPathMaxBytes = 1_024;
/**
 * Data closure can precede the Runner's final audit records. Retain their
 * fenced destination until the terminal report, with a deadline so a lost
 * Runner cannot leave history pending indefinitely.
 */
const finalizationRetentionMs = 60_000;
const finalizationMaxRecords = 512;
/** A terminal write that failed is retried on its own, on a bounded backoff. */
const terminalRetryMaxAttempts = 6;
const terminalRetryBaseMs = 250;
const terminalRetryMaxMs = 30_000;
const auditMarkerMaxAttempts = 6;
const auditMarkerBaseMs = 250;
const auditMarkerMaxMs = 30_000;

export type ShellHubStore = Pick<
  OpensteerStore,
  | "activateShellSession"
  | "appendShellEvents"
  | "effectiveMachineOwner"
  | "endShellSession"
  | "getMachineAccessTarget"
  | "getThreadForOwner"
  | "reserveShellSession"
>;

interface ShellControlEntry {
  readonly peer: ShellControlPeer;
  stream: RunnerAuxiliaryStream;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

interface ShellSession {
  readonly authority: ShellSessionAuthority;
  readonly callerRunnerId: RunnerId;
  /** The exact `shell` stream the reservation named, which nothing else may serve. */
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly nonce: string;
  /** When the open stops being allowed to finish, whatever is still awaited. */
  readonly openDeadlineAt: number;
  readonly policyRevision: number;
  /**
   * Whether the durable reservation row exists, or never will.
   *
   * Publishing the session and writing its row are two steps, and an ending can
   * land between them. So the ending waits for this before writing its own end:
   * a terminal claim still happens at once, but the row it ends is the row this
   * promise says is there.
   */
  readonly reserved: Promise<boolean>;
  readonly runId: RunId;
  readonly runnerId: RunnerId;
  readonly sessionId: ShellSessionId;
  readonly settle: Deferred;
  /** The caller's request, so activation can see it has gone rather than wait. */
  readonly signal: AbortSignal;
  readonly targetName: string;
  /**
   * Who opened the session, as their token said; rechecked against the grant,
   * not the token. Its Run and binding generation name the grant that admitted
   * it, which a refreshed token for the same grant leaves unchanged.
   */
  readonly scope: AgentControlRunScope;
  /** One activation runs at a time; both endpoints can arrive at once. */
  activating: boolean;
  announced: boolean;
  audit: { readonly at: Date; readonly event: ShellAuditEvent }[];
  /** Everything accepted so far, which the queue's own length forgets on flush. */
  auditAccepted: number;
  auditFlushing: Promise<void> | null;
  auditTruncated: boolean;
  /** Bytes the caller sent into the machine, and bytes the machine sent back. */
  bytesIn: number;
  bytesOut: number;
  caller: ShellByteSocket | null;
  data: ShellByteSocket | null;
  dataClaimed: boolean;
  /** Reads the target's socket from the moment it exists, forwards on demand. */
  dataPump: ShellPumpHandle | null;
  endReason: ShellCloseReason | null;
  opened: boolean;
  openTimer: NodeJS.Timeout | undefined;
  pumps: ShellPumpHandle[];
  state: "pending" | "active" | "ended";
}

/**
 * The ending one session earned, kept until it is durably written down.
 *
 * Removing a session from memory and writing its ending are two steps, and the
 * write can fail. Without this the next terminal call would find nothing, take
 * the unknown-session path, and record some later reason with no counters —
 * replacing the true story with a plausible one. So the winning reason and the
 * absolute counters are held here and retried exactly as they were.
 */
interface ShellTerminalRecord {
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly reason: ShellCloseReason;
  readonly runnerId: RunnerId;
  readonly session: ShellSession;
  readonly sessionId: ShellSessionId;
  readonly summary: ShellSessionSummary;
  /** How many times the durable write has been tried and failed. */
  attempts: number;
  /** The target has been asked to let go; asking twice says nothing new. */
  closeRequested: boolean;
  /** The durable write in flight, so a later ending event joins it instead of racing it. */
  persisting: Promise<{ readonly ended: boolean }> | null;
  retryTimer: NodeJS.Timeout | undefined;
}

/**
 * Ending access must not discard audit still in the helper's pipe or on the
 * control stream. This record admits only that session's fenced final records;
 * it never restores the data connection or its authorization.
 */
interface ShellFinalization {
  readonly expiresAt: number;
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly session: ShellSession;
  timer: NodeJS.Timeout | undefined;
}

/** A truncation marker that is owed to one session's history. */
interface ShellAuditMarkerDebt {
  attempts: number;
  paying: Promise<void> | null;
}

export interface ShellHubOptions {
  readonly authenticator: Pick<
    RunnerAuthenticator,
    "issueShellDataTicket" | "verifyShellDataTicket"
  >;
  readonly callerTokens: Pick<AgentControlTokenService, "authenticate" | "reauthorize">;
  readonly notifier: MachineAccessNotifier;
  readonly now?: () => number;
  /** Audit persistence is diagnostic: it never affects a byte in flight. */
  readonly onAuditError: (sessionId: ShellSessionId, error: unknown) => void;
  readonly onControlError: (runnerId: RunnerId, error: unknown) => void;
  readonly openTimeoutMs?: number;
  readonly runners: Pick<RunnerRegistry, "identityForRunner">;
  readonly store: ShellHubStore;
  readonly terminationDeadlineMs?: number;
}

/**
 * Every shell session this Host is routing, and the state machine that admits
 * and ends them.
 *
 * Three rules shape all of it. A session is not real until both of its sockets
 * exist and the whole authorization has been checked a second time, so nothing
 * is upgraded and no SSH byte moves until then — which is what lets a failure
 * anywhere in the open still reach the caller as one printable sentence. A
 * session ends exactly once, by whichever reason arrived first, because every
 * one of the many things that can end it races the others and the one that won
 * is the true story. And a terminal claim waits for nothing: it is a
 * synchronous state change that stops the transports, queued behind no send, no
 * database call and no other session's turn, because one unreachable computer
 * or one slow write must not be able to stop every other session on this Host
 * from being stopped. What an ending owes durably is settled afterwards.
 */
export class ShellHub implements ShellControlStreamHandler {
  readonly #byPeer = new Map<string, ShellControlEntry>();
  readonly #byRunner = new Map<RunnerId, ShellControlEntry>();
  readonly #sessions = new Map<ShellSessionId, ShellSession>();
  readonly #tombstones = new Map<ShellSessionId, ShellTerminalRecord>();
  readonly #finalized = new Map<ShellSessionId, ShellFinalization>();
  readonly #auditMarkers = new Map<ShellSessionId, ShellAuditMarkerDebt>();
  readonly #auditWrites = new Set<Promise<void>>();
  readonly #options: ShellHubOptions;
  readonly #now: () => number;
  readonly #openTimeoutMs: number;
  readonly #terminationDeadlineMs: number;
  /**
   * One machine's admission, activation, policy writes and terminal claims take
   * turns; different machines never wait on each other.
   *
   * These are the things that can disagree about whether a session exists:
   * capacity is reserved under this, the second authorization check runs under
   * it, a terminal reason is claimed under it, and the RPC that commits a new
   * policy or revokes the machine passes through it too. So an ended session
   * can never activate, two callers can never share the last free slot, and a
   * session can never activate against a policy that changed while its own
   * revalidation was reading.
   */
  readonly #machineTurns = new Map<RunnerId, Promise<unknown>>();
  #closed = false;

  constructor(options: ShellHubOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#openTimeoutMs = options.openTimeoutMs ?? defaultOpenTimeoutMs;
    this.#terminationDeadlineMs = options.terminationDeadlineMs ?? defaultTerminationDeadlineMs;
  }

  // ---- control stream --------------------------------------------------

  attach(peer: ShellControlPeer, stream: RunnerAuxiliaryStream): void {
    if (this.#closed) throw new Error("The shell hub is closed.");
    const entry: ShellControlEntry = { peer, stream };
    this.#byPeer.set(peer.id, entry);
    this.#byRunner.set(stream.identity.runnerId, entry);
  }

  renew(peer: ShellControlPeer, stream: RunnerAuxiliaryStream): void {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) return;
    entry.stream = stream;
  }

  /**
   * The stream went, and why it went is the reason its sessions ended.
   *
   * A revoked machine's sessions did not lose their connection; they lost the
   * machine. Recording that as a disconnection would tell the person who
   * revoked it that the computer happened to drop off at the same moment.
   */
  detach(peer: ShellControlPeer, reason: RunnerStreamLossReason): void {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) return;
    this.#byPeer.delete(peer.id);
    const runnerId = entry.stream.identity.runnerId;
    if (this.#byRunner.get(runnerId) === entry) this.#byRunner.delete(runnerId);
    this.#endMachineSessionsInBackground(runnerId, shellLossReason(reason));
  }

  detachRunner(runnerId: RunnerId, reason: RunnerStreamLossReason): void {
    const entry = this.#byRunner.get(runnerId);
    if (!entry) {
      this.#endMachineSessionsInBackground(runnerId, shellLossReason(reason));
      return;
    }
    this.detach(entry.peer, reason);
    entry.peer.close(reason === "revoked" ? 4003 : 4001, `shell stream ${reason}`);
  }

  /**
   * Reads one module message and returns.
   *
   * The auxiliary dispatcher is serial: everything else this machine has to say
   * — heartbeats, other sessions' lifecycles — waits behind whatever happens
   * here. So nothing here waits on a send, a database write, or another
   * session's turn; the work those need is handed to the background and this
   * returns.
   */
  async handleMessage(
    peer: ShellControlPeer,
    stream: RunnerAuxiliaryStream,
    message: ShellModuleEvent,
  ): Promise<void> {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The shell control stream is not attached.",
      });
    }
    const session = this.#sessions.get(message.sessionId);
    // A session this stream was never asked to serve is not this stream's to
    // report on. Answering a lifecycle message with a close is what lets a
    // target let go of a session left over from a Host that is no longer here.
    if (!session || !sameRunnerAuxiliaryFence(session.fence, stream.fence)) {
      const finalization = this.#finalized.get(message.sessionId);
      if (
        finalization &&
        finalization.expiresAt > this.#now() &&
        sameRunnerAuxiliaryFence(finalization.fence, stream.fence)
      ) {
        if (message.type === "runner.shell.event") {
          this.#queueAudit(finalization.session, message.event);
          return;
        }
        if (message.type === "runner.shell.session.closed") {
          if ((message.auditDropped ?? 0) > 0) this.#markAuditTruncated(finalization.session);
          if (finalization.timer) clearTimeout(finalization.timer);
          this.#finalized.delete(message.sessionId);
          return;
        }
      }
      if (message.type !== "runner.shell.event") {
        this.#background(entry.stream.identity.runnerId, () =>
          this.#send(entry, {
            ...stream.fence,
            reason: "open-failed",
            sessionId: message.sessionId,
            type: "host.shell.session.close",
          }),
        );
      }
      return;
    }
    switch (message.type) {
      case "runner.shell.session.opened":
        // A repeat on an already-active session says nothing new.
        if (session.state !== "pending") return;
        session.opened = true;
        this.#maybeActivate(session);
        return;
      case "runner.shell.session.rejected":
        this.#background(session.runnerId, () => this.end(session.sessionId, "open-failed"));
        return;
      case "runner.shell.session.closed": {
        // Requests the target could not deliver are still requests that were
        // made, so the history says it is incomplete before it is closed.
        if ((message.auditDropped ?? 0) > 0) this.#markAuditTruncated(session);
        this.#background(session.runnerId, async () => {
          await this.end(session.sessionId, message.reason);
          const finalization = this.#finalized.get(session.sessionId);
          if (finalization?.timer) clearTimeout(finalization.timer);
          this.#finalized.delete(session.sessionId);
        });
        return;
      }
      case "runner.shell.event":
        this.#queueAudit(session, message.event);
        return;
    }
  }

  // ---- admission -------------------------------------------------------

  /**
   * Admits one caller and returns only once its session is active.
   *
   * Everything before the return is reversible and reportable: the caller's
   * socket has not been upgraded yet, so a failure at any step is still an HTTP
   * body with a sentence in it rather than a WebSocket that closes for no
   * stated reason.
   */
  async connect(input: {
    readonly signal: AbortSignal;
    readonly target: RunnerId;
    readonly token: string;
  }): Promise<ShellSessionId> {
    const shuttingDown = () => rejection("target_offline", "Opensteer is shutting down.");
    if (this.#closed) throw shuttingDown();
    let scope: AgentControlRunScope;
    try {
      scope = await this.#options.callerTokens.authenticate(input.token);
    } catch {
      throw rejection("run_invalid", "This Run has ended.");
    }
    const target = await this.#options.store.getMachineAccessTarget(input.target);
    if (!target) {
      throw rejection(
        "target_unknown",
        `No computer ${input.target} is enrolled in this Deployment.`,
      );
    }
    if (!target.shell) {
      throw rejection(
        "module_unavailable",
        `${target.name} cannot accept connections from other computers yet; update Opensteer on it.`,
      );
    }
    if (!(await this.#reachAdmits(input.target, target.policy, scope))) {
      throw rejection("reach_denied", `${target.name} does not allow access from other computers.`);
    }
    const offline = () =>
      rejection(
        "target_offline",
        `${target.name} is offline (${describeMachineLastSeen(target.lastSeenAt, this.#now())}).`,
      );
    // Shutdown takes every control stream away, so it has to be read before
    // their absence is: a caller that arrived as the Host was going is told
    // that, not that the computer it asked for happens to be offline.
    if (this.#closed) throw shuttingDown();
    if (!this.#liveStream(input.target)) throw offline();
    const thread = await this.#options.store.getThreadForOwner(scope.threadId, scope.requestedBy);
    if (!thread) throw rejection("run_invalid", "This Run has ended.");
    const callerMachineName = await this.#callerMachineName(scope.runnerId);
    const settle = deferred();
    let admitReservation!: (inserted: boolean) => void;
    const reservation = new Promise<boolean>((resolve) => {
      admitReservation = resolve;
    });

    const reserved = await this.#withMachine(input.target, () => {
      // Every step above was awaited, and shutdown began in one of those gaps
      // for somebody. A session published now would be one `close` has already
      // walked past, so it would stay open with nothing left to end it.
      if (this.#closed) throw shuttingDown();
      if (
        this.#countSessions((entry) => entry.runnerId === input.target) >=
        machineAccessMaxActiveSessions
      ) {
        throw rejection(
          "too_many_sessions",
          `${target.name} already has ${machineAccessMaxActiveSessions} open connections.`,
        );
      }
      if (
        this.#countSessions((entry) => entry.runId === scope.runId) >= machineAccessMaxRunSessions
      ) {
        throw rejection(
          "too_many_sessions",
          `This Run already has ${machineAccessMaxRunSessions} open connections.`,
        );
      }
      // The stream may have been superseded while the reads above ran, and a
      // reservation is bound to one exact stream.
      const current = this.#liveStream(input.target);
      if (!current) throw offline();
      const sessionId = ShellSessionIdSchema.parse(`shs_${randomUUID()}`);
      const startedAt = new Date(this.#now());
      const ticket = this.#options.authenticator.issueShellDataTicket({
        fence: current.stream.fence,
        sessionId,
      });
      const authority: ShellSessionAuthority = {
        callerMachineName,
        policyRevision: target.revision,
        requestedBy: scope.requestedBy,
        runId: scope.runId,
        sessionId,
        startedAt: startedAt.toISOString(),
        threadId: scope.threadId,
        threadTitle: thread.title,
        workspaceId: scope.workspaceId,
      };
      const session: ShellSession = {
        activating: false,
        announced: false,
        audit: [],
        auditAccepted: 0,
        auditFlushing: null,
        auditTruncated: false,
        authority,
        bytesIn: 0,
        bytesOut: 0,
        caller: null,
        callerRunnerId: scope.runnerId,
        data: null,
        dataClaimed: false,
        dataPump: null,
        endReason: null,
        fence: current.stream.fence,
        nonce: ticket.claims.nonce,
        openDeadlineAt: this.#now() + this.#openTimeoutMs,
        opened: false,
        openTimer: undefined,
        policyRevision: target.revision,
        pumps: [],
        reserved: reservation,
        runId: scope.runId,
        runnerId: input.target,
        sessionId,
        settle,
        signal: input.signal,
        state: "pending",
        targetName: target.name,
        scope,
      };
      // In memory first: the capacity this reservation holds has to be visible
      // to the next caller before anything is awaited, or two of them take it.
      this.#sessions.set(sessionId, session);
      // The deadline starts here, not after the target has been told, so a send
      // that never completes cannot also postpone giving up on it.
      session.openTimer = setTimeout(() => {
        this.#background(input.target, () => this.end(sessionId, "open-timeout"));
      }, this.#openTimeoutMs);
      session.openTimer.unref();
      return { current, session, startedAt, ticket: ticket.ticket };
    });

    try {
      await this.#options.store.reserveShellSession({
        callerMachineName,
        callerRunnerId: scope.runnerId,
        policyRevision: target.revision,
        requestedBy: scope.requestedBy,
        runId: scope.runId,
        runnerId: input.target,
        sessionId: reserved.session.sessionId,
        startedAt: reserved.startedAt,
        threadId: scope.threadId,
        threadTitle: thread.title,
      });
      admitReservation(true);
    } catch (error) {
      // Nothing durable exists and nothing ever will, so an ending has no row
      // to write and must not sit waiting for one.
      admitReservation(false);
      this.#background(input.target, () => this.end(reserved.session.sessionId, "open-failed"));
      throw error;
    }
    if (this.#closed) {
      this.#background(input.target, () => this.end(reserved.session.sessionId, "host-shutdown"));
    }
    // Only a session that is still waiting is announced. One that ended while
    // its row was being written has a close on the way to the target already,
    // and an `open` arriving after it would ask for the session back.
    if (reserved.session.state === "pending") {
      reserved.session.announced = true;
      // Told in the background: a target that has stopped reading its control
      // stream must cost this session its open timeout and nothing else.
      this.#background(input.target, () =>
        this.#send(reserved.current, {
          ...reserved.current.stream.fence,
          authority: reserved.session.authority,
          dataTicket: reserved.ticket,
          machineName: target.name,
          policy: target.policy,
          sessionId: reserved.session.sessionId,
          type: "host.shell.session.open",
        }),
      );
    }

    const abandon = () => {
      this.#background(input.target, () =>
        this.end(
          reserved.session.sessionId,
          reserved.session.state === "active" ? "client-closed" : "open-failed",
        ),
      );
    };
    input.signal.addEventListener("abort", abandon, { once: true });
    if (input.signal.aborted) abandon();
    this.#maybeActivate(reserved.session);
    await settle.promise;
    return reserved.session.sessionId;
  }

  /** Pairs the caller's upgraded socket and starts moving bytes. */
  attachCaller(sessionId: ShellSessionId, socket: ShellByteSocket): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.state !== "active" || session.caller) {
      socket.close(1011, "shell session is not active");
      return;
    }
    session.caller = socket;
    const closed = () => {
      this.#background(session.runnerId, () => this.end(sessionId, "client-closed"));
    };
    socket.once("close", closed);
    socket.once("error", closed);
    this.#startForwarding(session);
  }

  /**
   * Claims the one unpaired data endpoint a reservation is waiting for.
   *
   * The ticket's nonce is burned by reading it, so a second presentation of the
   * same credential is refused before anything here runs. The rest — that it
   * has not expired while this call waited its turn, that the stream it named
   * is still the stream serving this machine, that the session it named is
   * still waiting to be paired — is decided inside the machine's admission
   * turn, together with the claim itself, so a claim cannot be granted against
   * a fence or a deadline that moved while it was queued.
   */
  async claimDataSocket(ticket: string): Promise<ShellSessionId> {
    const claims = this.#options.authenticator.verifyShellDataTicket(ticket);
    return this.#withMachine(claims.runnerId, () => {
      const session = this.#sessions.get(claims.sessionId);
      if (
        !session ||
        session.state !== "pending" ||
        session.dataClaimed ||
        session.nonce !== claims.nonce ||
        !sameRunnerAuxiliaryFence(session.fence, claims)
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "That shell data ticket names no session waiting to be paired",
        });
      }
      if (
        Date.parse(claims.expiresAt) <= this.#now() ||
        session.openDeadlineAt <= this.#now() ||
        session.signal.aborted
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "That shell data ticket is no longer valid",
        });
      }
      const stream = this.#liveStream(session.runnerId);
      if (!stream || !sameRunnerAuxiliaryFence(stream.stream.fence, session.fence)) {
        throw new OpensteerError({
          code: "conflict",
          message: "The computer's shell stream is no longer the one that was asked",
        });
      }
      session.dataClaimed = true;
      return session.sessionId;
    });
  }

  /** Holds the target's socket, silent, until activation lets bytes move. */
  attachDataSocket(sessionId: ShellSessionId, socket: ShellByteSocket): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.state !== "pending" || !session.dataClaimed || session.data) {
      socket.close(1011, "shell session is not waiting for a data socket");
      return;
    }
    // Nothing is forwarded before activation. What the target sends anyway is
    // read by the pump from this moment, so it counts against the same bounded
    // queue as everything after activation rather than against nothing at all.
    socket.pause();
    session.data = socket;
    const pump = pumpShellBytes({
      onBytes: (bytes) => {
        session.bytesOut += bytes;
      },
      onFailure: () => {
        this.#background(session.runnerId, () => this.end(sessionId, "protocol-error"));
      },
      source: socket,
    });
    session.dataPump = pump;
    session.pumps.push(pump);
    socket.once("close", (...args: unknown[]) => {
      const reported = closeFrameReason(args[1]) ?? "target-closed";
      this.#background(session.runnerId, () => this.end(sessionId, reported));
    });
    socket.once("error", () => {
      this.#background(session.runnerId, () => this.end(sessionId, "target-closed"));
    });
    this.#maybeActivate(session);
  }

  // ---- ending ----------------------------------------------------------

  async end(
    sessionId: ShellSessionId,
    reason: ShellCloseReason,
    options: { readonly idempotency?: { readonly key: string; readonly requestedBy: UserId } } = {},
  ): Promise<{ readonly ended: boolean }> {
    // Outside the machine's admission turn, on purpose. Claiming is a
    // synchronous state change, and so is the commit that makes a session
    // active, so whichever runs first still wins without either taking a turn —
    // while a claim that queued for the turn would wait behind an admission or
    // a policy write that is inside a database call it cannot hurry.
    const claimed = this.#claimTerminal(sessionId, reason);
    if (claimed === "already-claimed") return { ended: false };
    if (claimed === null) {
      // A row with no live session and nothing owed here: another Host epoch,
      // or a Stop that arrived after the reaper. The durable end is still owed,
      // and still idempotent.
      return this.#options.store.endShellSession({
        reason,
        sessionId,
        ...(options.idempotency ? { idempotency: options.idempotency } : {}),
      });
    }
    return this.#persistTerminal(claimed, options);
  }

  async endRunSessions(runId: RunId, reason: ShellCloseReason): Promise<void> {
    await this.#endMatching((session) => session.runId === runId, reason);
  }

  /**
   * Ends what these grants admitted, and nothing a later grant of the same Run
   * did: a restart's replacement attempt keeps its sessions whenever the word
   * about the attempt it replaced arrives.
   */
  async endGrantSessions(
    grants: readonly Pick<RevokedRunGrant, "bindingGeneration" | "runId">[],
    reason: ShellCloseReason,
  ): Promise<void> {
    await this.#endMatching(
      (session) =>
        grants.some(
          (grant) =>
            grant.runId === session.runId &&
            grant.bindingGeneration === session.scope.bindingGeneration,
        ),
      reason,
    );
  }

  async endMachineSessions(runnerId: RunnerId, reason: ShellCloseReason): Promise<void> {
    await this.#endMatching((session) => session.runnerId === runnerId, reason);
  }

  /**
   * Runs one thing in a machine's admission turn.
   *
   * A policy write and a revocation decide whether the sessions being admitted
   * right now are still authorized, so they belong in the same queue as
   * admission and activation rather than beside it. Do not call anything that
   * takes this turn again from inside the task.
   */
  async withMachineAdmission<Result>(
    runnerId: RunnerId,
    task: () => Promise<Result> | Result,
  ): Promise<Result> {
    return this.#withMachine(runnerId, task);
  }

  /**
   * What one machine's live sessions have actually moved.
   *
   * The row holds zeroes until the session ends, because writing a counter per
   * message would be a database write per SSH packet. The live numbers are
   * here, so the summary a manager reads is overlaid from here.
   */
  liveSessionBytes(
    runnerId: RunnerId,
  ): ReadonlyMap<ShellSessionId, { readonly bytesIn: number; readonly bytesOut: number }> {
    const live = new Map<ShellSessionId, { readonly bytesIn: number; readonly bytesOut: number }>();
    for (const session of this.#sessions.values()) {
      if (session.runnerId !== runnerId) continue;
      live.set(session.sessionId, { bytesIn: session.bytesIn, bytesOut: session.bytesOut });
    }
    return live;
  }

  /** Host shutdown: no session survives a Host epoch, so none is left open. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#endMatching(() => true, "host-shutdown");
    // Endings whose writes failed earlier are still owed, and their scheduled
    // retries will not outlive this process. Each gets one more attempt here;
    // the startup sweep of open rows is what stands behind that.
    const outstanding = [...this.#tombstones.values()];
    for (const record of outstanding) {
      if (record.retryTimer) clearTimeout(record.retryTimer);
      record.retryTimer = undefined;
      record.attempts = 0;
    }
    await Promise.allSettled(outstanding.map((record) => this.#persistTerminal(record)));
    const auditFinalizations = [...this.#finalized.values()];
    for (const finalization of auditFinalizations) {
      if (finalization.timer) clearTimeout(finalization.timer);
      this.#markAuditTruncated(finalization.session);
    }
    this.#finalized.clear();
    await Promise.allSettled(
      auditFinalizations.map((finalization) => this.#flushAudit(finalization.session)),
    );
    await Promise.allSettled(
      [...this.#auditMarkers.entries()].map(([sessionId, debt]) =>
        this.#payAuditMarker(sessionId, debt),
      ),
    );
    await Promise.allSettled(this.#auditWrites);
    const attached = Array.from(this.#byPeer.values());
    this.#byPeer.clear();
    this.#byRunner.clear();
    for (const entry of attached) entry.peer.close(1001, "Host shutting down");
  }

  /**
   * Ends every matching session, claiming them all before writing any of them.
   *
   * The claims are one synchronous pass: every affected transport has stopped
   * before the first database call is made, so one machine whose write hangs
   * cannot leave another machine's session moving bytes, and a Run-wide Stop is
   * not a queue of writes each waiting for the one in front of it.
   */
  async #endMatching(
    matches: (session: ShellSession) => boolean,
    reason: ShellCloseReason,
  ): Promise<void> {
    const matching: ShellSessionId[] = [];
    for (const session of this.#sessions.values()) {
      if (matches(session)) matching.push(session.sessionId);
    }
    const claimed: ShellTerminalRecord[] = [];
    for (const sessionId of matching) {
      const record = this.#claimTerminal(sessionId, reason);
      if (record && record !== "already-claimed") claimed.push(record);
    }
    await Promise.allSettled(claimed.map((record) => this.#persistTerminal(record)));
  }

  #endMachineSessionsInBackground(runnerId: RunnerId, reason: ShellCloseReason): void {
    this.#background(runnerId, () => this.endMachineSessions(runnerId, reason));
  }

  /**
   * Claims the terminal reason, takes the sockets away, and hands back what is
   * owed durably. Everything here is synchronous, which is what makes a Stop
   * immediate: nothing between claiming the reason and stopping the transports
   * can be delayed by a peer that stopped reading or a write that stalled.
   */
  #claimTerminal(
    sessionId: ShellSessionId,
    reason: ShellCloseReason,
  ): ShellTerminalRecord | "already-claimed" | null {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      // Removed from memory but never written down: retry that exact record
      // rather than invent a second ending with no counters.
      return this.#tombstones.get(sessionId) ?? null;
    }
    if (session.endReason !== null) return "already-claimed";
    session.endReason = reason;
    session.state = "ended";
    if (session.openTimer) clearTimeout(session.openTimer);
    session.openTimer = undefined;
    // Forwarding stops before anything is awaited: a Stop must never wait on a
    // peer that has stopped reading.
    for (const pump of session.pumps) pump.stop();
    session.pumps = [];
    session.dataPump = null;
    this.#sessions.delete(sessionId);
    session.settle.reject(openFailure(session.targetName, reason));
    this.#closeEndpoint(session.caller);
    this.#closeEndpoint(session.data);
    const record: ShellTerminalRecord = {
      attempts: 0,
      bytesIn: session.bytesIn,
      bytesOut: session.bytesOut,
      closeRequested: false,
      persisting: null,
      reason,
      retryTimer: undefined,
      runnerId: session.runnerId,
      session,
      sessionId,
      summary: this.#summary(session),
    };
    this.#tombstones.set(sessionId, record);
    if (session.announced) this.#rememberFinalization(session);
    return record;
  }

  /** Everything an ending owes outside the machine's turn. */
  /**
   * One durable write per ending, however many events report it.
   *
   * The Stop that claimed a session and the socket closes that follow it all
   * arrive at the same record; the first write in flight is the one they all
   * await, so no two writes race for the row's single transition and the
   * claimer reads back the outcome of its own ending. A write that failed and
   * is waiting out its backoff is retried at once by the next event instead.
   */
  #persistTerminal(
    record: ShellTerminalRecord,
    options: {
      readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
    } = {},
  ): Promise<{ readonly ended: boolean }> {
    if (record.persisting) return record.persisting;
    if (record.retryTimer) {
      clearTimeout(record.retryTimer);
      record.retryTimer = undefined;
    }
    const pending = this.#writeTerminal(record, options).finally(() => {
      if (record.persisting === pending) record.persisting = null;
    });
    record.persisting = pending;
    return pending;
  }

  async #writeTerminal(
    record: ShellTerminalRecord,
    options: {
      readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
    } = {},
  ): Promise<{ readonly ended: boolean }> {
    if (!record.closeRequested) {
      record.closeRequested = true;
      this.#requestTargetClose(record);
    }
    // The row this ending belongs to may still be being written. Ending a row
    // that is not there yet writes nothing and then lets the insert land behind
    // it, leaving a session that is durably open and live nowhere.
    if (!(await record.session.reserved)) {
      this.#releaseTombstone(record);
      return { ended: false };
    }
    const ended = await this.#options.store
      .endShellSession({
        bytesIn: record.bytesIn,
        bytesOut: record.bytesOut,
        reason: record.reason,
        sessionId: record.sessionId,
        ...(options.idempotency ? { idempotency: options.idempotency } : {}),
      })
      .catch((error: unknown) => {
        this.#options.onControlError(record.runnerId, error);
        return null;
      });
    await this.#flushAudit(record.session);
    // The tombstone is released only once the ending is durable. Until then it
    // retries itself, because the thing that would otherwise write this row is
    // another terminal event that may never come.
    if (ended === null) {
      this.#scheduleTerminalRetry(record);
      return { ended: false };
    }
    this.#releaseTombstone(record);
    if (ended.ended) {
      this.#options.notifier.ended({
        endReason: record.reason,
        runnerId: record.runnerId,
        session: record.summary,
      });
    }
    return ended;
  }

  /**
   * Tries a failed terminal write again, on its own, a bounded number of times.
   *
   * A durable row that stays open outlives the process that could close it, and
   * the person looking at it is told a session is still running. The retries
   * are capped because the startup sweep ends every open row anyway; this is
   * about a Host that is still here recovering from a moment of database
   * trouble, not about guaranteeing the write.
   */
  #scheduleTerminalRetry(record: ShellTerminalRecord): void {
    if (record.retryTimer || record.attempts >= terminalRetryMaxAttempts) return;
    const delay = Math.min(terminalRetryBaseMs * 2 ** record.attempts, terminalRetryMaxMs);
    record.attempts += 1;
    const timer = setTimeout(() => {
      record.retryTimer = undefined;
      if (this.#tombstones.get(record.sessionId) !== record) return;
      this.#background(record.runnerId, () => this.#persistTerminal(record));
    }, delay);
    timer.unref();
    record.retryTimer = timer;
  }

  #releaseTombstone(record: ShellTerminalRecord): void {
    if (record.retryTimer) clearTimeout(record.retryTimer);
    record.retryTimer = undefined;
    if (this.#tombstones.get(record.sessionId) === record) {
      this.#tombstones.delete(record.sessionId);
    }
  }

  /**
   * Keeps an ended session's audit sink until the Runner finishes draining it.
   *
   * Bounded both ways — a minute, and a ceiling on how many — because this is a
   * courtesy to a message still in flight, not a second session table.
   */
  #rememberFinalization(session: ShellSession): void {
    const now = this.#now();
    for (const [sessionId, record] of this.#finalized) {
      if (record.expiresAt > now) break;
      this.#markAuditTruncated(record.session);
      if (record.timer) clearTimeout(record.timer);
      this.#finalized.delete(sessionId);
    }
    while (this.#finalized.size >= finalizationMaxRecords) {
      const oldest = this.#finalized.keys().next();
      if (oldest.done) break;
      const record = this.#finalized.get(oldest.value);
      if (record) {
        this.#markAuditTruncated(record.session);
        if (record.timer) clearTimeout(record.timer);
      }
      this.#finalized.delete(oldest.value);
    }
    const finalization: ShellFinalization = {
      expiresAt: now + finalizationRetentionMs,
      fence: session.fence,
      session,
      timer: undefined,
    };
    const timer = setTimeout(() => {
      if (this.#finalized.get(session.sessionId) !== finalization) return;
      this.#markAuditTruncated(session);
      this.#finalized.delete(session.sessionId);
    }, finalizationRetentionMs);
    timer.unref();
    finalization.timer = timer;
    this.#finalized.set(session.sessionId, finalization);
  }

  // ---- internals -------------------------------------------------------

  #maybeActivate(session: ShellSession): void {
    if (session.state !== "pending" || !session.opened || !session.data) return;
    // Both endpoints can arrive in either order, and the activation that
    // follows is no longer one uninterrupted turn, so it says so itself.
    if (session.activating) return;
    session.activating = true;
    void this.#activate(session).catch((error: unknown) => {
      this.#options.onControlError(session.runnerId, error);
      this.#background(session.runnerId, () => this.end(session.sessionId, "open-failed"));
    });
  }

  /**
   * The second authorization check, and the only thing that makes a session
   * real.
   *
   * Everything it re-reads could have changed while the target was starting its
   * helper: the Run could have ended, the machine could have reconnected under
   * a new fence, its owner could have saved new access settings, the caller
   * could have given up, the open could simply have taken too long. A session
   * that activated on a stale answer would be a session nobody authorized.
   *
   * It happens in two turns with the durable promotion between them. The reads
   * belong in a turn, because a policy write must not commit underneath them.
   * The write does not: it can stall, and a Stop, a detach or the open deadline
   * must not queue behind a row this session is the only one waiting for.
   */
  async #activate(session: ShellSession): Promise<void> {
    if (session.state !== "pending") return;
    const failure = await this.#withMachine(session.runnerId, () => this.#revalidate(session));
    if (failure) {
      await this.end(session.sessionId, failure);
      return;
    }
    const promoted = await this.#options.store
      .activateShellSession(session.sessionId)
      .catch((error: unknown) => {
        this.#options.onControlError(session.runnerId, error);
        return false;
      });
    const late = await this.#withMachine(session.runnerId, () =>
      this.#commitActivation(session, promoted),
    );
    if (late) await this.end(session.sessionId, late);
  }

  /**
   * The moment a session becomes real, decided with nothing awaited.
   *
   * Everything that disqualifies it is re-read here rather than remembered from
   * before the promotion: the caller, the deadline, and the stream itself,
   * because a detach or a lease expiry during that write leaves this session
   * bound to a stream that is no longer serving the machine. A commit against
   * one of those would resolve the caller's connect and announce a session that
   * has nowhere to send a byte.
   */
  #commitActivation(session: ShellSession, promoted: boolean): ShellCloseReason | null {
    // Already ended while the promotion ran: the first reason won, and it has
    // its own ending on the way.
    if (session.state !== "pending") return null;
    if (!promoted) return "open-failed";
    const late = this.#openWindowClosed(session);
    if (late) return late;
    if (!this.#servesSession(session)) return "machine-disconnected";
    session.state = "active";
    if (session.openTimer) clearTimeout(session.openTimer);
    session.openTimer = undefined;
    session.settle.resolve();
    this.#options.notifier.started({
      runnerId: session.runnerId,
      session: this.#summary(session),
    });
    return null;
  }

  /** The caller went, or the open ran out of time — neither may be waited on. */
  #openWindowClosed(session: ShellSession): ShellCloseReason | null {
    if (session.signal.aborted) return "open-failed";
    if (this.#now() >= session.openDeadlineAt) return "open-timeout";
    return null;
  }

  async #revalidate(session: ShellSession): Promise<ShellCloseReason | null> {
    const early = this.#openWindowClosed(session);
    if (early) return early;
    if (!this.#servesSession(session)) return "machine-disconnected";
    let scope: AgentControlRunScope;
    try {
      // A session outlives the token that opened it; its Run's grant must not.
      scope = await this.#options.callerTokens.reauthorize(session.scope);
    } catch {
      return "run-ended";
    }
    if (scope.runId !== session.runId) return "run-ended";
    const target = await this.#options.store.getMachineAccessTarget(session.runnerId);
    if (!target?.shell) return "machine-revoked";
    if (target.revision !== session.policyRevision) return "policy-changed";
    if (!(await this.#reachAdmits(session.runnerId, target.policy, scope))) return "policy-changed";
    // The stream is read again after the awaited checks: a detach is
    // synchronous and can land between any two of them.
    if (!this.#servesSession(session)) return "machine-disconnected";
    return null;
  }

  /** Whether the stream this machine is on is still the one that was asked. */
  #servesSession(session: ShellSession): boolean {
    const stream = this.#liveStream(session.runnerId);
    return Boolean(stream && sameRunnerAuxiliaryFence(stream.stream.fence, session.fence));
  }

  #startForwarding(session: ShellSession): void {
    const caller = session.caller;
    const data = session.data;
    if (!caller || !data) return;
    const onFailure = () => {
      this.#background(session.runnerId, () => this.end(session.sessionId, "protocol-error"));
    };
    const callerPump = pumpShellBytes({
      destination: data,
      onBytes: (bytes) => {
        session.bytesIn += bytes;
      },
      onFailure,
      source: caller,
    });
    session.pumps.push(callerPump);
    session.dataPump?.start(caller);
    data.resume();
  }

  #closeEndpoint(socket: ShellByteSocket | null): void {
    if (!socket) return;
    if (socket.readyState === shellSocketOpen) socket.close(1000, "shell session ended");
    // A socket paused for backpressure will never finish an orderly close, so
    // it is taken away on a deadline rather than waited on.
    const deadline = setTimeout(() => socket.terminate(), this.#terminationDeadlineMs);
    deadline.unref();
  }

  #requestTargetClose(record: ShellTerminalRecord): void {
    const entry = this.#byRunner.get(record.runnerId);
    if (!entry || !sameRunnerAuxiliaryFence(entry.stream.fence, record.session.fence)) return;
    this.#background(record.runnerId, () =>
      this.#send(entry, {
        ...entry.stream.fence,
        reason: record.reason,
        sessionId: record.sessionId,
        type: "host.shell.session.close",
      }),
    );
  }

  async #send(
    entry: ShellControlEntry,
    message: Parameters<ShellControlPeer["send"]>[0],
  ): Promise<void> {
    await entry.peer
      .send(message)
      .catch((error: unknown) =>
        this.#options.onControlError(entry.stream.identity.runnerId, error),
      );
  }

  /** Work nothing may wait on, whose only failure mode is a reported error. */
  #background(runnerId: RunnerId, task: () => Promise<unknown>): void {
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => this.#options.onControlError(runnerId, error));
  }

  /** The one marker a session's history carries when anything was left out. */
  #markAuditTruncated(session: ShellSession): void {
    if (session.auditTruncated) return;
    session.auditTruncated = true;
    // Through the queue, so the marker lands after the requests it follows.
    session.audit.push({ at: new Date(this.#now()), event: { kind: "truncated" } });
    if (!session.auditFlushing) void this.#flushAudit(session);
  }

  /**
   * The marker a history is owed when the queue it would have travelled in is
   * gone — a batch that could not be written, or a loss reported after the
   * session itself was removed.
   *
   * It is retried on a backoff because a history that silently omits requests
   * is the one thing the audit contract does not allow, and the batch that was
   * lost cannot be recovered to carry it.
   */
  #oweAuditMarker(sessionId: ShellSessionId): void {
    if (this.#auditMarkers.has(sessionId)) return;
    const debt: ShellAuditMarkerDebt = { attempts: 0, paying: null };
    this.#auditMarkers.set(sessionId, debt);
    // Reported as an audit failure rather than a control one, and never waited
    // on: persistence is diagnostic, as it is everywhere else here.
    void this.#payAuditMarker(sessionId, debt);
  }

  async #payAuditMarker(sessionId: ShellSessionId, debt: ShellAuditMarkerDebt): Promise<void> {
    if (debt.paying) return debt.paying;
    const paying = this.#writeAuditMarker(sessionId, debt).finally(() => {
      if (debt.paying === paying) debt.paying = null;
    });
    debt.paying = paying;
    return paying;
  }

  async #writeAuditMarker(sessionId: ShellSessionId, debt: ShellAuditMarkerDebt): Promise<void> {
    try {
      await this.#options.store.appendShellEvents(sessionId, [
        { at: new Date(this.#now()), event: { kind: "truncated" } },
      ]);
      this.#auditMarkers.delete(sessionId);
    } catch (error) {
      this.#options.onAuditError(sessionId, error);
      debt.attempts += 1;
      if (debt.attempts >= auditMarkerMaxAttempts) {
        this.#auditMarkers.delete(sessionId);
        return;
      }
      const delay = Math.min(auditMarkerBaseMs * 2 ** (debt.attempts - 1), auditMarkerMaxMs);
      const timer = setTimeout(() => {
        void this.#payAuditMarker(sessionId, debt);
      }, delay);
      timer.unref();
    }
  }

  #queueAudit(session: ShellSession, event: ShellAuditEvent): void {
    if (session.auditTruncated) return;
    if (session.auditAccepted >= shellAuditEventCap) {
      this.#markAuditTruncated(session);
      return;
    }
    session.auditAccepted += 1;
    session.audit.push({ at: new Date(this.#now()), event: boundAuditEvent(event) });
    // Never inside the control dispatcher: a database write there would make
    // every other message on this machine's stream wait behind it.
    if (!session.auditFlushing) void this.#flushAudit(session);
  }

  async #flushAudit(session: ShellSession): Promise<void> {
    if (session.auditFlushing) return session.auditFlushing;
    const flushing = this.#writeAudit(session).finally(() => {
      if (session.auditFlushing === flushing) session.auditFlushing = null;
      this.#auditWrites.delete(flushing);
    });
    session.auditFlushing = flushing;
    this.#auditWrites.add(flushing);
    return flushing;
  }

  async #writeAudit(session: ShellSession): Promise<void> {
    try {
      while (session.audit.length > 0) {
        const batch = session.audit.splice(0, session.audit.length);
        await this.#options.store.appendShellEvents(session.sessionId, batch);
      }
    } catch (error) {
      this.#options.onAuditError(session.sessionId, error);
      // Those requests are gone and cannot be written again, so the history is
      // incomplete whatever else happens. Discarding the batch and saying
      // nothing would leave a record that reads as the whole story.
      session.audit.length = 0;
      session.auditTruncated = true;
      this.#oweAuditMarker(session.sessionId);
    }
  }

  #countSessions(matches: (session: ShellSession) => boolean): number {
    let count = 0;
    for (const session of this.#sessions.values()) if (matches(session)) count += 1;
    return count;
  }

  #liveStream(runnerId: RunnerId): ShellControlEntry | null {
    const entry = this.#byRunner.get(runnerId);
    if (!entry) return null;
    return Date.parse(entry.stream.streamLeaseExpiresAt) > this.#now() ? entry : null;
  }

  async #reachAdmits(
    runnerId: RunnerId,
    policy: MachineAccessPolicy,
    scope: AgentControlRunScope,
  ): Promise<boolean> {
    // A Run never reaches the computer it is already running on: reach is about
    // other computers, and the Run's ssh config has no alias for its own.
    if (runnerId === scope.runnerId) return false;
    if (policy.reach === "nobody") return false;
    if (policy.reach === "deployment") return true;
    const ownership = await this.#options.store.effectiveMachineOwner(runnerId);
    return ownership?.effectiveOwner === scope.requestedBy;
  }

  async #callerMachineName(runnerId: RunnerId): Promise<string> {
    const identity = this.#options.runners.identityForRunner(runnerId);
    if (identity) return identity.name;
    const record = await this.#options.store.getMachineAccessTarget(runnerId);
    if (!record) throw rejection("run_invalid", "This Run has ended.");
    return record.name;
  }

  #summary(session: ShellSession): ShellSessionSummary {
    return ShellSessionSummarySchema.parse({
      bytesIn: session.bytesIn,
      bytesOut: session.bytesOut,
      callerMachineName: session.authority.callerMachineName,
      id: session.sessionId,
      requestedBy: session.authority.requestedBy,
      runId: session.runId,
      startedAt: session.authority.startedAt,
      threadId: session.authority.threadId,
      threadTitle: session.authority.threadTitle,
    });
  }

  #withMachine<Result>(runnerId: RunnerId, task: () => Promise<Result> | Result): Promise<Result> {
    const previous = this.#machineTurns.get(runnerId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#machineTurns.set(runnerId, settled);
    void settled.then(() => {
      if (this.#machineTurns.get(runnerId) === settled) this.#machineTurns.delete(runnerId);
    });
    return result;
  }
}

/** What losing a machine's stream means for the sessions it was carrying. */
function shellLossReason(reason: RunnerStreamLossReason): ShellCloseReason {
  return reason === "revoked" ? "machine-revoked" : "machine-disconnected";
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settleResolve, settleReject) => {
    resolve = settleResolve;
    reject = settleReject;
  });
  // A reservation that ends before anyone awaits it still rejects, and an
  // unobserved rejection must not take the process down.
  promise.catch(() => undefined);
  return { promise, reject, resolve };
}

function rejection(code: ShellConnectErrorCode, message: string): ShellConnectRejection {
  return new ShellConnectRejection(code, message);
}

/**
 * What a caller is told when its session died during the open.
 *
 * The code is a coarse classification for the transport; the sentence is the
 * whole truth, because the ssh proxy prints the sentence and nothing else.
 */
function openFailure(targetName: string, reason: ShellCloseReason): ShellConnectRejection {
  switch (reason) {
    case "run-ended":
      return rejection("run_invalid", "This Run has ended.");
    case "stopped-by-owner":
      return rejection("reach_denied", `${targetName}'s owner stopped this connection.`);
    case "policy-changed":
      return rejection(
        "reach_denied",
        `${targetName} changed its access settings while this connection was opening.`,
      );
    case "machine-revoked":
      return rejection("target_unknown", `${targetName} was removed from this Deployment.`);
    case "host-shutdown":
      return rejection("target_offline", "Opensteer is shutting down.");
    default:
      return rejection("target_offline", `${targetName} did not accept the connection.`);
  }
}

/** The wire caps, enforced here too: the Host stores what it was told, bounded. */
function boundAuditEvent(event: ShellAuditEvent): ShellAuditEvent {
  switch (event.kind) {
    case "exec":
      return { ...event, command: clampBytes(event.command, auditCommandMaxBytes) };
    case "sftp.open":
      return { ...event, path: clampBytes(event.path, auditPathMaxBytes) };
    case "sftp.mutate":
      return {
        ...event,
        path: clampBytes(event.path, auditPathMaxBytes),
        ...(event.target ? { target: clampBytes(event.target, auditPathMaxBytes) } : {}),
      };
    default:
      return event;
  }
}

function clampBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let cut = value;
  while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
  return cut;
}

/**
 * A close reason the target put on its WebSocket close frame. A target that
 * says why it is going is believed ahead of the generic "the socket closed",
 * which is the only way an idle timeout reads as one.
 */
function closeFrameReason(reason: unknown): ShellCloseReason | null {
  const text =
    typeof reason === "string" ? reason : Buffer.isBuffer(reason) ? reason.toString("utf8") : null;
  if (text === null || text === "") return null;
  const parsed = ShellCloseReasonSchema.safeParse(text);
  return parsed.success ? parsed.data : null;
}
