import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  PasswordsBrokerSignInDecisionSchema,
  PasswordsBrokerSignInApproveResultSchema,
  PasswordsBrokerSignInRequestParamsSchema,
  PasswordsBrokerSignInRequestV5ParamsSchema,
  PasswordsBrokerSignInReleaseParamsSchema,
  PasswordsBrokerSignInReleaseV5ParamsSchema,
  passwordsBrokerLatestProtocolVersion,
  type PasswordsBrokerSignInRequestV5Params,
  type PasswordsBrokerLogin,
  type PasswordsBrokerSignInDecision,
  type PasswordsBrokerSignInApproveResult,
  passwordsBrokerMaxFrameBytes,
  type PasswordsBrokerStatus,
} from "@opensteer/protocol/passwords-broker";
import {
  encodeLengthPrefixedJson,
  LengthPrefixedJsonReader,
} from "@opensteer/shared/lengthPrefixedJson";

import {
  FakePasswordsBrokerSession,
  fakePasswordsLogin,
  type FakePasswordsGrant,
  type FakePasswordsLogin,
} from "./fake-broker-session.js";

/**
 * Reads the peer's credentials off an inherited fd 3 with `LOCAL_PEERCRED`
 * (`SOL_LOCAL` 0, option 1, `struct xucred {u_int cr_version; uid_t cr_uid; …}`)
 * and exits 0 only when the version is `XUCRED_VERSION` (0) and the uid is the
 * expected one: the development broker's `.sameUser` peer mode, done by the
 * kernel rather than by trusting a path. `/usr/bin/perl` is part of macOS, so
 * this needs no developer tools and prompts for nothing.
 */
const sameUserScript = [
  "use IO::Handle;",
  'my $s = IO::Handle->new_from_fd(3, "r+") or exit 2;',
  "my $c = getsockopt($s, 0, 1) or exit 2;",
  'my ($version, $uid) = unpack("L L", $c);',
  "exit(($version == 0 && $uid == $ARGV[0]) ? 0 : 3);",
].join(" ");

/**
 * Checks the process on the other end of `socket` runs as `expectedUid`, by
 * lending the socket to a short-lived verifier as fd 3, exactly as the real
 * peer checks lend it. Lending pauses the socket's readable side, so the
 * caller resumes it.
 */
export async function verifySameUserPeer(
  socket: Socket,
  expectedUid: number = currentUid(),
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/perl", ["-e", sameUserScript, String(expectedUid)], {
      stdio: ["ignore", "ignore", "ignore", socket],
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`The peer is not this user (${signal ?? String(code)}).`));
    });
  });
}

export function currentUid(): number {
  if (typeof process.getuid !== "function") throw new Error("This platform has no user ids.");
  return process.getuid();
}

export type FakeBrokerFrame = Readonly<Record<string, unknown>>;

export interface FakeBrokerTranscriptEntry {
  readonly connection: number;
  readonly direction: "in" | "out";
  readonly frame: unknown;
}

interface HeldCall {
  readonly connection: number;
  readonly id: number;
  readonly method: string;
  readonly params: FakeBrokerFrame;
  readonly socket: Socket;
}

export interface FakePasswordsBrokerOptions {
  readonly brokerVersion?: string;
  readonly development: boolean;
  /**
   * `same-user`: every accepted connection is checked with the kernel's peer
   * credentials before a frame is read, and refused unanswered otherwise.
   */
  readonly peerMode?: "same-user" | "none";
  /** The uid the same-user check expects; another one stands in for a foreign user. */
  readonly peerUid?: number;
  readonly protocolVersion?: number;
  readonly socketPath: string;
  readonly status?: PasswordsBrokerStatus;
}

/**
 * A stand-in for `Opensteer Passwords` speaking the real wire: 4-byte
 * big-endian length-prefixed JSON on a Unix socket, `hello` first, every
 * request answered by id, `status.changed` pushed. Person-facing calls are
 * held until the test answers them, as the real broker holds them until the
 * person does.
 */
export class FakePasswordsBroker {
  readonly transcript: FakeBrokerTranscriptEntry[] = [];
  readonly refusedPeers: number[] = [];
  readonly #options: FakePasswordsBrokerOptions;
  readonly #sockets = new Map<Socket, number>();
  readonly #held: HeldCall[] = [];
  readonly #sessions = new Map<Socket, FakePasswordsBrokerSession>();
  readonly #versions = new Map<Socket, number>();
  readonly #v5 = new Map<
    Socket,
    Map<
      string,
      {
        params: PasswordsBrokerSignInRequestV5Params;
        login: PasswordsBrokerLogin | null;
        remembered: boolean;
      }
    >
  >();
  readonly #logins = new Map<string, FakePasswordsLogin>([
    [fakePasswordsLogin.id, fakePasswordsLogin],
  ]);
  readonly #grants = new Map<string, FakePasswordsGrant>();

  setLogin(login: FakePasswordsLogin): void {
    this.#logins.set(login.id, login);
  }

  revokeGrants(): void {
    this.#grants.clear();
  }
  readonly #handlers = new Map<string, (params: FakeBrokerFrame) => unknown>();
  readonly #failures = new Map<string, { code: string; message: string }>();
  readonly #arrivals = new Set<() => void>();
  #nextRelease: Promise<void> | null = null;
  /** Every listener started; a relaunch binds the path again while older ones keep serving. */
  readonly #servers: Server[] = [];
  #connections = 0;
  #status: PasswordsBrokerStatus;

  constructor(options: FakePasswordsBrokerOptions) {
    this.#options = options;
    this.#status = options.status ?? { agentSignIns: "on", vault: "ready" };
  }

  get connections(): number {
    return this.#connections;
  }

  get openConnections(): number {
    return this.#sockets.size;
  }

  get listening(): boolean {
    return this.#servers.some((server) => server.listening);
  }

  async listen(): Promise<void> {
    await unlink(this.#options.socketPath).catch(() => undefined);
    const server = createServer((socket) => void this.#accept(socket));
    this.#servers.push(server);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(this.#options.socketPath, () => {
        server.off("error", rejectPromise);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets.keys()) socket.destroy();
    for (const server of this.#servers.splice(0)) {
      if (!server.listening) continue;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }

  /** Answers `method` with `handler(params)` instead of the default. */
  reply(method: string, handler: (params: FakeBrokerFrame) => unknown): void {
    this.#handlers.set(method, handler);
  }

  /** Refuses `method` with the broker's own error shape. */
  fail(method: string, error: { code: string; message: string }): void {
    this.#failures.set(method, error);
  }

  clearFailure(method: string): void {
    this.#failures.delete(method);
  }

  /** Hold one real release while a test disconnects its browser surface. */
  holdNextRelease(): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#nextRelease = promise;
    return resolve;
  }

  /** The status the broker reports, pushed to every connection as `status.changed`. */
  setStatus(status: PasswordsBrokerStatus): void {
    this.#status = status;
    for (const session of this.#sessions.values()) session.status = status;
    this.broadcast({ event: "status.changed", params: status });
  }

  broadcast(frame: unknown): void {
    for (const [socket, connection] of this.#sockets) this.#write(socket, connection, frame);
  }

  /** Bytes as they are, for frames the encoder would refuse to build. */
  sendRaw(bytes: Buffer): void {
    for (const socket of this.#sockets.keys()) socket.write(bytes);
  }

  dropConnections(): void {
    for (const socket of this.#sockets.keys()) socket.destroy();
  }

  /** Calls waiting for the person, oldest first. */
  held(method?: string): readonly HeldCall[] {
    return this.#held.filter((call) => method === undefined || call.method === method);
  }

  /** The person's answer to the oldest held call of `method`. */
  answer(method: string, result: unknown): void {
    const index = this.#held.findIndex((call) => call.method === method);
    const call = this.#held[index];
    if (!call) throw new Error(`No ${method} is waiting for the person.`);
    this.#held.splice(index, 1);
    const parsed = (
      method === "signin.approve"
        ? PasswordsBrokerSignInApproveResultSchema
        : PasswordsBrokerSignInDecisionSchema
    ).safeParse(result);
    if (parsed.success && typeof call.params.transactionId === "string") {
      this.#sessions
        .get(call.socket)
        ?.applyDecision(
          call.params.transactionId,
          parsed.data,
          method === "signin.request" || call.params.remember === true,
        );
      this.#applyV5Decision(
        call.socket,
        call.params.transactionId,
        parsed.data,
        method === "signin.request" || call.params.remember === true,
      );
    }
    this.#write(call.socket, call.connection, { id: call.id, result });
  }

  /** Every frame received for `method`, in order. */
  received(method: string): readonly FakeBrokerFrame[] {
    return this.transcript
      .filter((entry) => entry.direction === "in")
      .map((entry) => entry.frame as FakeBrokerFrame)
      .filter((frame) => frame.method === method);
  }

  /** Resolves once a frame for `method` has arrived. */
  async waitFor(method: string): Promise<FakeBrokerFrame> {
    for (;;) {
      const found = this.received(method)[0];
      if (found) return found;
      await new Promise<void>((resolvePromise) => this.#arrivals.add(resolvePromise));
    }
  }

  async #accept(socket: Socket): Promise<void> {
    this.#connections += 1;
    const connection = this.#connections;
    socket.once("error", () => socket.destroy());
    if ((this.#options.peerMode ?? "same-user") === "same-user") {
      try {
        await verifySameUserPeer(socket, this.#options.peerUid ?? currentUid());
      } catch {
        // An answer is itself information, so a refused peer gets none.
        this.refusedPeers.push(connection);
        socket.destroy();
        return;
      }
    }
    this.#sockets.set(socket, connection);
    const session = new FakePasswordsBrokerSession({ logins: this.#logins, grants: this.#grants });
    session.status = this.#status;
    this.#sessions.set(socket, session);
    socket.once("close", () => {
      this.#sockets.delete(socket);
      this.#sessions.get(socket)?.dropConnection();
      this.#sessions.delete(socket);
      this.#versions.delete(socket);
      this.#v5.delete(socket);
      for (let index = this.#held.length - 1; index >= 0; index -= 1) {
        if (this.#held[index]?.socket === socket) this.#held.splice(index, 1);
      }
    });
    const reader = new LengthPrefixedJsonReader(passwordsBrokerMaxFrameBytes);
    let greeted = false;
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        this.transcript.push({ connection, direction: "in", frame });
        for (const arrived of Array.from(this.#arrivals)) {
          this.#arrivals.delete(arrived);
          arrived();
        }
        const { id, method, params } = frame as {
          readonly id: number;
          readonly method: string;
          readonly params: FakeBrokerFrame;
        };
        if (!greeted) {
          if (method !== "hello") {
            socket.destroy();
            return;
          }
          greeted = true;
        }
        void this.#handle(socket, connection, id, method, params).catch(() => {
          this.#write(socket, connection, {
            id,
            error: { code: "invalid", message: "The parameters are not valid." },
          });
        });
      }
    });
    socket.resume();
  }

  async #handle(
    socket: Socket,
    connection: number,
    id: number,
    method: string,
    params: FakeBrokerFrame,
  ): Promise<void> {
    const failure = this.#failures.get(method);
    if (failure) {
      this.#write(socket, connection, { error: failure, id });
      return;
    }
    if (method === "signin.request") {
      if (this.#versions.get(socket) === 5) {
        const input = PasswordsBrokerSignInRequestV5ParamsSchema.parse(params);
        if (input.permissionVersion !== 5) throw new Error("Protocol 5 requires current consent");
        let transactions = this.#v5.get(socket);
        if (!transactions) {
          transactions = new Map();
          this.#v5.set(socket, transactions);
        }
        transactions.set(input.transactionId, { params: input, login: null, remembered: false });
      } else {
        const input = PasswordsBrokerSignInRequestParamsSchema.parse(params);
        await this.#sessions.get(socket)?.request(input, new AbortController().signal);
      }
    }
    const custom = this.#handlers.get(method);
    if (custom) {
      const result = custom(params);
      if (result !== undefined) {
        const parsed = (
          method === "signin.approve"
            ? PasswordsBrokerSignInApproveResultSchema
            : PasswordsBrokerSignInDecisionSchema
        ).safeParse(result);
        if (parsed.success && typeof params.transactionId === "string") {
          this.#sessions
            .get(socket)
            ?.applyDecision(
              params.transactionId,
              parsed.data,
              method === "signin.request" || params.remember === true,
            );
          this.#applyV5Decision(
            socket,
            params.transactionId,
            parsed.data,
            method === "signin.request" || params.remember === true,
          );
        }
        this.#write(socket, connection, { id, result });
      }
      return;
    }
    switch (method) {
      case "hello": {
        const requested = params.protocolVersion;
        if (requested !== 4 && requested !== 5) throw new Error("Unsupported protocol");
        const negotiated =
          this.#options.protocolVersion ??
          Math.min(requested, passwordsBrokerLatestProtocolVersion);
        this.#versions.set(socket, negotiated);
        this.#write(socket, connection, {
          id,
          result: {
            brokerVersion: this.#options.brokerVersion ?? "1.0.0",
            development: this.#options.development,
            protocolVersion: negotiated,
          },
        });
        return;
      }
      case "status":
        this.#write(socket, connection, { id, result: this.#status });
        return;
      case "signin.probe":
        this.#write(socket, connection, {
          id,
          result: {
            passwords:
              this.#status.vault === "ready"
                ? this.#status.agentSignIns === "on"
                  ? "has-login"
                  : "off"
                : "unavailable",
          },
        });
        return;
      case "signin.request":
      case "signin.approve":
        this.#held.push({ connection, id, method, params, socket });
        return;
      case "signin.release": {
        const held = this.#nextRelease;
        this.#nextRelease = null;
        await held;
        if (this.#versions.get(socket) === 5) {
          const input = PasswordsBrokerSignInReleaseV5ParamsSchema.parse(params);
          const transaction = this.#v5.get(socket)?.get(input.transactionId);
          const login = transaction?.login;
          const item = login && this.#logins.get(login.id);
          let reason: "ended" | "revoked" | "wrong-site" | "no-totp" | "passwords-off" | undefined;
          if (!transaction || !login || Date.parse(transaction.params.expiresAt) <= Date.now())
            reason = "ended";
          else if (this.#status.agentSignIns === "off") reason = "passwords-off";
          else if (!item || item.revision !== login.revision || this.#status.vault !== "ready")
            reason = "revoked";
          else if (
            transaction.remembered &&
            this.#grants.get(
              JSON.stringify([
                transaction.params.deploymentId,
                transaction.params.workspaceId,
                transaction.params.site,
              ]),
            )?.permissionVersion !== 5
          )
            reason = "revoked";
          else if (
            input.kind === "browser" &&
            (!item.origins.includes(input.origin) || new URL(input.origin).origin !== input.origin)
          )
            reason = "wrong-site";
          else if (input.field === "totp" && item.totp === null) reason = "no-totp";
          const result = reason
            ? { released: false, reason }
            : { released: true, value: input.field === "totp" ? item!.totp! : item![input.field] };
          this.#write(socket, connection, { id, result });
          return;
        }
        const input = PasswordsBrokerSignInReleaseParamsSchema.parse(params);
        const result = await this.#sessions.get(socket)?.release(input);
        this.#write(socket, connection, { id, result });
        return;
      }
      case "signin.cancel": {
        if (typeof params.transactionId === "string")
          this.#v5.get(socket)?.delete(params.transactionId);
        if (typeof params.transactionId === "string")
          await this.#sessions.get(socket)?.cancel(params.transactionId);
        // Withdrawal ends every held call for the transaction with a v4 error.
        for (;;) {
          const index = this.#held.findIndex(
            (call) => call.socket === socket && call.params.transactionId === params.transactionId,
          );
          const withdrawn = this.#held[index];
          if (withdrawn) {
            this.#held.splice(index, 1);
            this.#write(socket, connection, {
              id: withdrawn.id,
              error: { code: "invalid", message: "That sign-in ended." },
            });
          } else break;
        }
        this.#write(socket, connection, { id, result: {} });
        return;
      }
      default:
        this.#write(socket, connection, { id, result: {} });
    }
  }

  #applyV5Decision(
    socket: Socket,
    transactionId: string,
    decision: PasswordsBrokerSignInDecision | PasswordsBrokerSignInApproveResult,
    remembered: boolean,
  ): void {
    const transaction = this.#v5.get(socket)?.get(transactionId);
    if (!transaction || decision.decision !== "authorized") return;
    transaction.login = decision.login;
    transaction.remembered = remembered;
    if (remembered)
      this.#grants.set(
        JSON.stringify([
          transaction.params.deploymentId,
          transaction.params.workspaceId,
          transaction.params.site,
        ]),
        { id: decision.login.id, revision: decision.login.revision, permissionVersion: 5 },
      );
  }

  #write(socket: Socket, connection: number, frame: unknown): void {
    if (socket.destroyed) return;
    this.transcript.push({ connection, direction: "out", frame });
    socket.write(encodeLengthPrefixedJson(frame, passwordsBrokerMaxFrameBytes));
  }
}
