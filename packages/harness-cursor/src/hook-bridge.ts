import { OpensteerError } from "@opensteer/core";
import { setPrivateDirectoryMode, setFileMode } from "@opensteer/shared/privateFiles";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const cursorHookSocketFileName = "cursor-hook.sock";

/**
 * The approval socket's own directory.
 *
 * A Unix socket address is a fixed-size struct — 104 bytes of path on macOS —
 * and a Thread state directory under the Runner's data directory routinely
 * exceeds that on its own, so the socket cannot live beside the plugin. It
 * gets a short private directory of its own instead, mode 0700 and removed
 * when the session stops. On a native-user Runner the person's own temporary
 * directory is the same trust domain as the plugin directory, so this changes
 * nothing about who can reach the socket.
 */
export async function createCursorHookSocketDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-cursor-"));
  await setPrivateDirectoryMode(directory);
  return directory;
}

export function cursorHookSocketPath(socketDirectory: string): string {
  const path = join(socketDirectory, cursorHookSocketFileName);
  // Defensive: a temporary directory this long is a machine nobody can bind a
  // socket on at all, and an ENAMETOOLONG from bind() mid-Run says far less
  // than the path does.
  if (Buffer.byteLength(path, "utf8") >= 100) {
    throw new OpensteerError({
      code: "harness_error",
      message: `Cursor approval socket path is too long for this computer: ${path}`,
    });
  }
  return path;
}

/** What the hook program prints back to Cursor. */
export interface CursorHookVerdict {
  readonly agentMessage?: string;
  readonly permission: "allow" | "deny";
  readonly userMessage?: string;
}

export type CursorHookPayload = Readonly<Record<string, unknown>>;

export interface CursorHookBridgeOptions {
  /**
   * Answers one hook payload. It may wait as long as the person does, and
   * `abandoned` fires when the hook program went away first — Cursor kills it
   * at the hook's own timeout, and a Request nobody can answer any more must
   * not stay open in front of a person.
   */
  readonly decide: (
    payload: CursorHookPayload,
    abandoned: AbortSignal,
  ) => Promise<CursorHookVerdict>;
  readonly maximumPayloadBytes: number;
  readonly socketPath: string;
}

/**
 * The Run's side of the approval channel.
 *
 * Cursor's hook is an ordinary blocking subprocess, so one connection is one
 * tool call waiting for an answer, and the answer may take as long as the
 * person does. Nothing is trusted from the wire beyond "it is a JSON object":
 * the payload is Cursor's private, unversioned shape (cursor-facts open risk
 * 4), so the driver reads the fields it knows and treats the rest as detail.
 *
 * Closing the bridge drops every waiting connection, which the hook program
 * reads as a denial — a Run that has ended must not leave a tool call blocked
 * on an answer nobody can give.
 */
export class CursorHookBridge {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly socketPath: string;
  #closed = false;

  private constructor(server: Server, socketPath: string) {
    this.#server = server;
    this.socketPath = socketPath;
  }

  static async listen(options: CursorHookBridgeOptions): Promise<CursorHookBridge> {
    await rm(options.socketPath, { force: true });
    const server = createServer();
    const bridge = new CursorHookBridge(server, options.socketPath);
    server.on("connection", (socket) => bridge.#serve(socket, options));
    // A listener that throws after startup would otherwise reach the Runner as
    // an unhandled error; a broken approval channel denies instead.
    server.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await setFileMode(options.socketPath, 0o600);
    return bridge;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }

  #serve(socket: Socket, options: CursorHookBridgeOptions): void {
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    // The hook program is gone: Cursor timed it out, or the Run's process tree
    // was torn down. Whoever is waiting on the decision is told so it can stop
    // asking a person for an answer that can no longer be delivered.
    const abandoned = new AbortController();
    let settled = false;
    socket.on("close", () => {
      this.#sockets.delete(socket);
      if (!settled) abandoned.abort(new Error("The Cursor hook stopped waiting"));
    });
    let buffered = "";
    let answered = false;
    // Recorded before the write, so the close our own reply causes is never
    // read as the hook having abandoned the decision.
    const answer = (verdict: CursorHookVerdict) => {
      settled = true;
      this.#answer(socket, verdict);
    };
    socket.on("data", (chunk: string) => {
      if (answered) return;
      buffered += chunk;
      if (Buffer.byteLength(buffered, "utf8") > options.maximumPayloadBytes) {
        answered = true;
        answer({ permission: "deny", userMessage: "the hook payload was too large" });
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      answered = true;
      const line = buffered.slice(0, newline);
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        answer({ permission: "deny", userMessage: "the hook payload could not be read" });
        return;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        answer({ permission: "deny", userMessage: "the hook payload was not a JSON object" });
        return;
      }
      void options
        .decide(payload as CursorHookPayload, abandoned.signal)
        .then((verdict) => answer(verdict))
        .catch(() =>
          answer({ permission: "deny", userMessage: "Opensteer could not decide this tool call" }),
        );
    });
  }

  #answer(socket: Socket, verdict: CursorHookVerdict): void {
    if (socket.destroyed) return;
    socket.end(
      `${JSON.stringify({
        ...(verdict.agentMessage ? { agent_message: verdict.agentMessage } : {}),
        permission: verdict.permission,
        ...(verdict.userMessage ? { user_message: verdict.userMessage } : {}),
      })}\n`,
    );
  }
}
