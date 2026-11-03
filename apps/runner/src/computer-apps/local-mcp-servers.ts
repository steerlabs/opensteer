import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchPluginPackage, retainPluginPackages } from "../skills/plugin-cache.js";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isLoopbackHostname } from "@opensteer/core";
import type { LocalMcpLaunch } from "@opensteer/integration-core";
import {
  computerAppFrameFits,
  computerMcpMaxSessions,
  type HostIntegrationsMcpClose,
  type HostIntegrationsMcpMessage,
  type HostIntegrationsMcpOpen,
  type McpSessionCloseCode,
  type RunnerIntegrationsMcpClosed,
  type RunnerIntegrationsMcpMessage,
  type RunnerIntegrationsMcpOpened,
} from "@opensteer/protocol";

export type LocalMcpFrame =
  | Pick<RunnerIntegrationsMcpOpened, "sessionId" | "type">
  | Pick<RunnerIntegrationsMcpMessage, "message" | "sessionId" | "type">
  | Pick<RunnerIntegrationsMcpClosed, "error" | "sessionId" | "type">;

/** How much of a program's stderr is kept, to say why it stopped. */
const stderrTailBytes = 4_096;
/** How long a program has to end on SIGTERM before its group is killed. */
const terminationGraceMs = 2_000;
/**
 * The most a session holds of what it was sent and its server has not taken
 * yet, or of what its server wrote and has not finished; past it, the
 * session ends rather than this computer holding more.
 */
const maxBufferedBytes = 16 * 1_024 * 1_024;
const capacitySentence =
  "Already running as many MCP server sessions as it can; try again when one ends.";
const tooLargeSentence =
  "The MCP server sent a message larger than its stream carries, so its session ended.";
const notReadingSentence = "The MCP server stopped taking what it was sent, so its session ended.";

interface Session {
  readonly releasePackage?: (() => Promise<void>) | undefined;
  closing: boolean;
  error: Error | undefined;
  readonly transport: Transport & { readonly stderrTail?: string };
  /** Bytes sent to the server that it has not taken yet. */
  unsent: number;
}

/**
 * The MCP servers this computer runs for its Deployment
 * (`docs/computers.md`, "MCP servers on a computer").
 *
 * The Host is each server's MCP client; this carries the JSON-RPC messages of
 * one session to and from the program it started — or the server on its own
 * loopback — without reading them. The authenticated Host admits the exact
 * launch against its stored owner decision before opening a session. This
 * executor never accepts a decision from the desktop bridge.
 */
export class LocalMcpServers {
  readonly #stateDirectory: string | undefined;
  readonly #sessions = new Map<string, Session>();
  /** Bumped by every attach and detach; work begun under another one stops. */
  #generation = 0;
  #send: ((frame: LocalMcpFrame) => Promise<void>) | undefined;

  constructor(options: { readonly stateDirectory?: string } = {}) {
    this.#stateDirectory = options.stateDirectory;
  }
  attach(send: (frame: LocalMcpFrame) => Promise<void>): void {
    this.detach();
    this.#send = send;
  }

  /** The stream ended: every session ends with it, and every program it started. */
  detach(): void {
    this.#generation += 1;
    this.#send = undefined;
    for (const [sessionId, session] of this.#sessions) {
      this.#sessions.delete(sessionId);
      session.closing = true;
      void session.transport
        .close()
        .then(
          async () => {
            await session.releasePackage?.();
          },
          async () => {
            await session.releasePackage?.();
          },
        )
        .catch(() => undefined);
    }
  }

  async open(frame: HostIntegrationsMcpOpen): Promise<void> {
    const generation = this.#generation;
    if (this.#sessions.has(frame.sessionId)) return;
    if (this.#sessions.size >= computerMcpMaxSessions) {
      await this.#closed(frame.sessionId, "failed", capacitySentence);
      return;
    }
    let releasePackage: (() => Promise<void>) | undefined;
    let launch = frame.launch;
    if (launch.packageDigest) {
      try {
        if (!this.#stateDirectory || !launch.pluginId)
          throw new Error("Plugin cache is unavailable");
        releasePackage = await retainPluginPackages(this.#stateDirectory, [launch.packageDigest]);
        const root = await fetchPluginPackage({
          stateDirectory: this.#stateDirectory,
          digest: launch.packageDigest,
          fetchSnapshot: async () => {
            if (!frame.packageSource) throw new Error("Package source is unavailable");
            const response = await fetch(frame.packageSource.url, {
              headers: { authorization: `Bearer ${frame.packageSource.token}` },
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error(`Plugin package fetch failed: ${response.status}`);
            return JSON.parse(
              Buffer.from(
                await readBoundedResponse(response, {
                  maximumBytes: 96 * 1024 * 1024,
                  sizeError: () => new Error("Package too large"),
                }),
              ).toString("utf8"),
            ) as unknown;
          },
        });
        const data = path.join(this.#stateDirectory, "plugin-data", launch.pluginId);
        await mkdir(data, { recursive: true, mode: 0o700 });
        launch = resolvePluginLaunch(launch, root, data);
      } catch (error) {
        await releasePackage?.();
        await this.#closed(
          frame.sessionId,
          "failed",
          error instanceof Error ? error.message : "Plugin package unavailable",
        );
        return;
      }
    }
    if (generation !== this.#generation) {
      await releasePackage?.();
      return;
    }
    const transport = launchTransport(launch);
    const session: Session = {
      releasePackage,
      closing: false,
      error: undefined,
      transport,
      unsent: 0,
    };
    this.#sessions.set(frame.sessionId, session);
    transport.onmessage = (message: JSONRPCMessage) =>
      this.#relay(frame.sessionId, session, message);
    transport.onerror = (error) => {
      session.error ??= error;
      // Framing and transport failures end the session. Merely remembering
      // them leaves the Host awaiting an answer from a broken, live process.
      void this.#end(frame.sessionId, session, "failed", stoppedSentence(session));
    };
    transport.onclose = () => {
      if (this.#sessions.get(frame.sessionId) !== session) return;
      this.#sessions.delete(frame.sessionId);
      if (session.closing) return;
      // The program exited on its own; anything it started goes with it.
      session.closing = true;
      void transport
        .close()
        .then(
          async () => {
            await session.releasePackage?.();
          },
          async () => {
            await session.releasePackage?.();
          },
        )
        .catch(() => undefined);
      void this.#closed(frame.sessionId, "failed", stoppedSentence(session));
    };
    try {
      await transport.start();
    } catch (error) {
      session.error ??= error instanceof Error ? error : new Error(String(error));
      await this.#end(frame.sessionId, session, "failed", stoppedSentence(session));
      return;
    }
    if (generation !== this.#generation || session.closing) {
      await transport.close().catch(() => undefined);
      return;
    }
    await this.#emit({ sessionId: frame.sessionId, type: "runner.integrations.mcp.opened" });
  }

  /**
   * Hands the server one message and returns: the stream's frames are
   * handled one at a time, so waiting for a slow server to read would hold up
   * every other app on this computer. A message it cannot take ends the session.
   */
  message(frame: HostIntegrationsMcpMessage): void {
    const session = this.#sessions.get(frame.sessionId);
    if (!session) return;
    const bytes = Buffer.byteLength(JSON.stringify(frame.message));
    if (session.unsent + bytes > maxBufferedBytes) {
      void this.#end(frame.sessionId, session, "failed", notReadingSentence);
      return;
    }
    session.unsent += bytes;
    session.transport.send(frame.message as JSONRPCMessage).then(
      () => {
        session.unsent -= bytes;
      },
      (error: unknown) => {
        session.error ??= error instanceof Error ? error : new Error(String(error));
        void this.#end(frame.sessionId, session, "failed", stoppedSentence(session));
      },
    );
  }

  async close(frame: HostIntegrationsMcpClose): Promise<void> {
    const session = this.#sessions.get(frame.sessionId);
    if (!session) return;
    this.#sessions.delete(frame.sessionId);
    session.closing = true;
    await session.transport.close().catch(() => undefined);
    await session.releasePackage?.();
  }

  #relay(sessionId: string, session: Session, message: JSONRPCMessage): void {
    if (session.closing) return;
    const frame: LocalMcpFrame = {
      // The SDK hands over what it parsed from the server's JSON, typed as
      // its own message shape; on the wire it is that JSON again.
      message: message as RunnerIntegrationsMcpMessage["message"],
      sessionId,
      type: "runner.integrations.mcp.message",
    };
    // The fence the stream adds is a few hundred bytes; this leaves room for it.
    if (!computerAppFrameFits({ ...frame, fence: "x".repeat(1_024) })) {
      void this.#end(sessionId, session, "too-large", tooLargeSentence);
      return;
    }
    void this.#emit(frame);
  }

  async #end(
    sessionId: string,
    session: Session,
    code: McpSessionCloseCode,
    message: string,
  ): Promise<void> {
    if (this.#sessions.get(sessionId) !== session) return;
    this.#sessions.delete(sessionId);
    session.closing = true;
    const generation = this.#generation;
    await session.transport.close().catch(() => undefined);
    await session.releasePackage?.();
    if (generation === this.#generation) await this.#closed(sessionId, code, message);
  }

  async #closed(sessionId: string, code: McpSessionCloseCode, message: string): Promise<void> {
    await this.#emit({
      error: { code, message: message.slice(0, 4_096) },
      sessionId,
      type: "runner.integrations.mcp.closed",
    });
  }

  async #emit(frame: LocalMcpFrame): Promise<void> {
    await this.#send?.(frame).catch(() => undefined);
  }
}

export function resolvePluginLaunch(
  launch: LocalMcpLaunch,
  root: string,
  data: string,
): LocalMcpLaunch {
  if (launch.type !== "stdio") return launch;
  const expand = (value: string) =>
    value.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${PLUGIN_DATA}", data);
  return {
    ...launch,
    command: expand(launch.command),
    cwd: expand(launch.cwd),
    args: launch.args.map(expand),
    env: {
      ...Object.fromEntries(Object.entries(launch.env).map(([k, v]) => [k, expand(v)])),
      PLUGIN_ROOT: root,
      PLUGIN_DATA: data,
    },
  };
}

function launchTransport(launch: LocalMcpLaunch): Session["transport"] {
  if (launch.type === "stdio") return new ProgramTransport(launch);
  const url = new URL(launch.url);
  // The schema holds this already; a launch that reaches past this computer
  // is not one it runs, whatever parsed it.
  if (!isLoopbackHostname(url.hostname)) throw new Error("A local MCP server listens on loopback");
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { ...launch.headers } },
  }) as unknown as Transport;
}

/**
 * A program's MCP session over its standard input and output, in a process
 * group of its own. A program is often a launcher — `npx`, `uvx`, a shell
 * script — whose own child is the server, so ending the session ends every
 * process the program started, not only the program.
 */
class ProgramTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #buffer = new ReadBuffer({ maxBufferSize: maxBufferedBytes });
  readonly #launch: Extract<LocalMcpLaunch, { readonly type: "stdio" }>;
  #child: ChildProcessWithoutNullStreams | undefined;
  /** The program's process group, which outlives the program when it started others. */
  #group: number | undefined;
  #stopping: Promise<void> | undefined;
  #stderr = "";

  constructor(launch: Extract<LocalMcpLaunch, { readonly type: "stdio" }>) {
    this.#launch = launch;
  }

  /** The end of what the program wrote to stderr, to say why it stopped. */
  get stderrTail(): string {
    return this.#stderr;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#launch.command, [...this.#launch.args], {
        cwd: this.#launch.cwd,
        detached: true,
        env: { ...getDefaultEnvironment(), ...this.#launch.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      // Spawning returns once the program started, in a group of its own, so
      // the group can be ended from here on — even before `spawn` is emitted.
      this.#group = child.pid;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", () => resolve());
      // The program is the server: once it exits, whatever it started and
      // left holding its output is not, and the session ends with the group.
      // What it wrote before exiting is still read from the pipe.
      child.once("exit", () => void this.close());
      child.once("close", () => {
        this.#child = undefined;
        this.onclose?.();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.#stopping) return;
        try {
          this.#buffer.append(chunk);
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        while (!this.#stopping) {
          let message: JSONRPCMessage | null;
          try {
            message = this.#buffer.readMessage();
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (message === null) break;
          this.onmessage?.(message);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-stderrTailBytes);
      });
      child.stdin.on("error", (error) => this.onerror?.(error));
    });
  }

  /**
   * Settles when the program's input took the message, or with why it could
   * not: a program that stopped reading never leaves a send waiting forever.
   */
  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (!stdin?.writable) return Promise.reject(new Error("The MCP server is not running."));
    return new Promise((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Ends the program and every process it started: the whole group is asked
   * to stop, and whatever of it is left after the grace is killed — however
   * soon the program itself exited.
   */
  close(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    const group = this.#group;
    if (group === undefined) return;
    this.#child?.stdin.destroy();
    signalGroup(group, "SIGTERM");
    const deadline = Date.now() + terminationGraceMs;
    while (groupAlive(group) && Date.now() < deadline) await delay(50);
    if (groupAlive(group)) signalGroup(group, "SIGKILL");
  }
}

/** Signals a program and everything it started, which share its process group. */
function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // Already gone.
  }
}

/** Whether any process of the group is still there. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stoppedSentence(session: Session): string {
  const reason = session.error?.message ?? null;
  const stderr = (session.transport.stderrTail ?? "").trim();
  return [
    reason ? `The MCP server stopped: ${reason}` : "The MCP server stopped.",
    stderr ? `Its last output: ${stderr.slice(-1_000)}` : null,
  ]
    .filter((line) => line !== null)
    .join(" ");
}
