import type { RunId, RunnerId, UserId } from "@opensteer/core";
import type { RunnerAuxiliaryStream, RunnerStreamLossReason } from "@opensteer/orchestration";
import type {
  RoutedHostToShellModuleMessage,
  ShellCloseReason,
  ShellModuleEvent,
  ShellSessionId,
} from "@opensteer/protocol";
import type { ShellByteSocket } from "./shell-byte-pump.js";

/**
 * What the `shell` module's control stream can do, as whatever routes sessions
 * over it sees. The fence, the lease and the Runner's identity all come from
 * the registry that admitted the socket.
 */
export interface ShellControlPeer {
  readonly id: string;
  close(code: number, reason: string): void;
  send(message: RoutedHostToShellModuleMessage): Promise<void>;
}

/** The Host's end of every `shell` control stream, and the sessions on it. */
export interface ShellControlStreamHandler {
  attach(peer: ShellControlPeer, stream: RunnerAuxiliaryStream): void;
  /** Pairs the caller's upgraded socket with an already-active session. */
  attachCaller(sessionId: ShellSessionId, socket: ShellByteSocket): void;
  /** Pairs the target's upgraded socket with the reservation that claimed it. */
  attachDataSocket(sessionId: ShellSessionId, socket: ShellByteSocket): void;
  /** Reads a one-use data ticket and claims the endpoint it names. */
  claimDataSocket(ticket: string): Promise<ShellSessionId>;
  /** Admits one caller, returning only once its session is active. */
  connect(input: {
    readonly signal: AbortSignal;
    readonly target: RunnerId;
    readonly token: string;
  }): Promise<ShellSessionId>;
  /** The socket went. */
  detach(peer: ShellControlPeer, reason: RunnerStreamLossReason): void;
  /** The registry dropped the stream, so no socket event will arrive. */
  detachRunner(runnerId: RunnerId, reason: RunnerStreamLossReason): void;
  /** Ends one session; idempotent, and the first terminal reason wins. */
  end(
    sessionId: ShellSessionId,
    reason: ShellCloseReason,
    options?: {
      /** Records the answer, so a retried Stop reads back what the first did. */
      readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
    },
  ): Promise<{ readonly ended: boolean }>;
  endMachineSessions(runnerId: RunnerId, reason: ShellCloseReason): Promise<void>;
  endRunSessions(runId: RunId, reason: ShellCloseReason): Promise<void>;
  handleMessage(
    peer: ShellControlPeer,
    stream: RunnerAuxiliaryStream,
    message: ShellModuleEvent,
  ): Promise<void>;
  /**
   * What one machine's live sessions have moved so far, which the row does not
   * know until they end.
   */
  liveSessionBytes(
    runnerId: RunnerId,
  ): ReadonlyMap<ShellSessionId, { readonly bytesIn: number; readonly bytesOut: number }>;
  /** Keeps the stream's renewed lease visible to whatever derives from it. */
  renew(peer: ShellControlPeer, stream: RunnerAuxiliaryStream): void;
  /**
   * Runs one thing in a machine's admission turn, so a policy write or a
   * revocation cannot commit while a session is part-way through deciding it is
   * still authorized.
   */
  withMachineAdmission<Result>(
    runnerId: RunnerId,
    task: () => Promise<Result> | Result,
  ): Promise<Result>;
}
