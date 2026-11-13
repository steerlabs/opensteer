import { OpensteerError } from "@opensteer/core";
import {
  Deferred,
  meetsMinimumVersion,
  type HarnessLog,
  type HarnessProcessLaunchWrapper,
} from "@opensteer/harness";
import { isRecord } from "@opensteer/shared/isRecord";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { CodexLaunch } from "./codex-driver.js";
import { MINIMUM_CODEX_CLI_VERSION, type CodexHarnessConfig } from "./config.js";
import { assertCodexFeatureBoundary, type CodexFeatureBoundary } from "./features.js";
import { CodexStdioClient } from "./process.js";
import {
  optionalString,
  protocolError,
  requireObject,
  requireString,
  type CodexMethodMessage,
} from "./protocol.js";

/**
 * Codex re-sends the whole turn's diff on every file change, so one line grows
 * with everything a turn writes. Opensteer reads file changes item by item.
 */
const codexOptedOutNotifications = ["turn/diff/updated"] as const;

/** Frames of a conversation nothing has claimed yet: a subagent or one still opening. */
const heldFramesMaxBytes = 8 * 1_024 * 1_024;
const heldFramesMaxAgeMs = 60_000;

/** How deep a chain of subagents nothing has named yet is traced to its Run. */
const parentDiscoveryMaxDepth = 8;
const parentDiscoveryTimeoutMs = 2_000;

/** Every capability a process's sessions held, kept out of its stderr for its whole life. */
const redactionsMax = 4_096;

/** How long an account's process waits for its next session once its last has ended. */
const codexAppServerIdleMs = 5 * 60_000;

/** One session's hold on a shared app-server, and where its conversations' frames go. */
export interface CodexThreadOwner {
  /** A notification or server request on a conversation this owner claimed. Never throws. */
  receive(message: CodexMethodMessage): void;
  /** The process is gone or retired: nothing it owed will arrive. */
  serverFailed(error: OpensteerError): void;
  /**
   * Codex did not answer a request about one of this owner's conversations in
   * time. Whether it acted on it is unknown, so the owner cannot go on.
   */
  requestTimedOut(error: OpensteerError): void;
}

export interface CodexAppServerOptions {
  readonly appServerArgs: readonly string[];
  readonly config: CodexHarnessConfig;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly features: CodexFeatureBoundary;
  readonly launch: CodexLaunch;
  readonly log?: HarnessLog;
  /** Called once, when the process can serve nothing more. */
  readonly onEnded?: (server: CodexAppServer) => void;
  /** Present when the process serves only one session and ends with it. */
  readonly dedicated?: true;
  /** Ends a dedicated process, starting or not, with its session's lifetime. */
  readonly signal?: AbortSignal;
  readonly wrapProcessLaunch?: HarnessProcessLaunchWrapper;
}

interface HeldFrames {
  bytes: number;
  readonly firstAt: number;
  readonly frames: CodexMethodMessage[];
  expiry?: NodeJS.Timeout;
}

/**
 * One `codex app-server` and the conversations it carries. A shared one serves
 * every session of an account, as T3 Code's does: what belongs to a Run travels
 * with its conversation, never on the process. Frames go to the session that
 * claimed their conversation, a subagent's to the session of the conversation
 * that spawned it; one session's error ends only that session. A failure of
 * the process itself ends every session on it, and the account's next session
 * starts a replacement.
 */
export class CodexAppServer {
  readonly client: CodexStdioClient;
  readonly dedicated: boolean;
  /** The feature boundary the process was started with; every conversation repeats it. */
  readonly features: CodexFeatureBoundary;
  readonly #after: { readonly message: CodexMethodMessage; readonly owner: CodexThreadOwner }[] =
    [];
  readonly #attached = new Set<CodexThreadOwner>();
  /** Its stderr tail outlives a session, so what a session held is redacted for the process's life. */
  readonly #redactions = new Set<string>();
  readonly #closeWaiters = new Map<string, Deferred<void>>();
  /** Conversations whose spawning conversation is being asked of Codex. */
  readonly #discovering = new Map<string, Promise<void>>();
  /** Frames that arrived while Codex was asked whose a conversation is, in wire order. */
  readonly #queued: { readonly bytes: number; readonly message: CodexMethodMessage }[] = [];
  #pausedBy = 0;
  readonly #held = new Map<string, HeldFrames>();
  readonly #lifetime: AbortController;
  readonly #log: HarnessLog | undefined;
  readonly #onEnded: CodexAppServerOptions["onEnded"];
  readonly #owners = new Map<string, CodexThreadOwner>();
  #closePromise: Promise<void> | undefined;
  #dispatching = false;
  #ended = false;
  #failure: OpensteerError | undefined;
  #heldBytes = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  #recycled = false;

  private constructor(
    client: CodexStdioClient,
    lifetime: AbortController,
    options: CodexAppServerOptions,
  ) {
    this.client = client;
    this.dedicated = options.dedicated === true;
    this.features = options.features;
    this.#lifetime = lifetime;
    this.#log = options.log;
    this.#onEnded = options.onEnded;
  }

  static async start(options: CodexAppServerOptions): Promise<CodexAppServer> {
    const lifetime = new AbortController();
    const abort = () => lifetime.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    let server: CodexAppServer | undefined;
    // Frames route only once the server exists; none arrive before initialize.
    const client = await CodexStdioClient.start({
      appServerArgs: options.appServerArgs,
      config: options.config,
      cwd: options.cwd,
      environment: options.environment,
      launch: options.launch,
      onFailure: (error) => {
        if (server) server.#fail(error);
      },
      onMethodMessage: (message, bytes) => {
        if (server) server.#route(message, bytes);
      },
      onRequestTimeout: (_method, params, error) => {
        if (!server) return;
        // A process that keeps no time takes no new session; the one waiting ends.
        server.recycle();
        const threadId = isRecord(params) ? optionalString(params.threadId) : undefined;
        const owner = threadId ? server.#owners.get(threadId) : undefined;
        owner?.requestTimedOut(error);
      },
      redactions: () => (server ? [...server.#redactions] : []),
      signal: lifetime.signal,
      ...(options.wrapProcessLaunch ? { wrapProcessLaunch: options.wrapProcessLaunch } : {}),
    });
    server = new CodexAppServer(client, lifetime, options);
    if (options.signal) {
      const started = server;
      options.signal.addEventListener("abort", () => void started.close(), { once: true });
      if (options.signal.aborted) void started.close();
    }
    try {
      const initialize = requireObject(
        await client.lifecycleRequest("initialize", {
          capabilities: {
            experimentalApi: true,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [...codexOptedOutNotifications],
            requestAttestation: false,
          },
          clientInfo: { name: "opensteer", title: "Opensteer", version: "0.0.0" },
        }),
        "initialize result",
      );
      assertSupportedCodexVersion(
        requireString(initialize.userAgent, "initialize result.userAgent"),
      );
      await client.notify("initialized", {});
      await assertCodexFeatureBoundary(client, options.features, options.config.startupTimeoutMs);
      // A start whose session gave up still ends unless another session comes.
      if (!server.dedicated) server.#idleUnlessAttached();
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  /** Whether a new session may attach. */
  get usable(): boolean {
    return !this.#ended && !this.#recycled && !this.#failure && !this.client.failed;
  }

  get failure(): OpensteerError | undefined {
    return this.#failure;
  }

  /**
   * Holds the process for a session. `redactions` are the session's
   * capabilities, kept out of the process's stderr diagnostics.
   */
  attach(owner: CodexThreadOwner, redactions: readonly string[]): void {
    if (!this.usable) {
      throw (
        this.#failure ??
        new OpensteerError({
          code: "harness_error",
          message: "Codex app-server no longer accepts sessions",
          retryable: true,
        })
      );
    }
    if (this.dedicated && this.#attached.size > 0 && !this.#attached.has(owner)) {
      throw new Error("A dedicated Codex app-server serves one session");
    }
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#attached.add(owner);
    for (const value of redactions) {
      if (value.length < 4) continue;
      this.#redactions.delete(value);
      this.#redactions.add(value);
      if (this.#redactions.size > redactionsMax) {
        this.#redactions.delete(this.#redactions.values().next().value!);
      }
    }
  }

  /** Every conversation `owner` holds, its subagents' before its own. */
  threadsOf(owner: CodexThreadOwner): string[] {
    return [...this.#owners]
      .filter(([, current]) => current === owner)
      .map(([threadId]) => threadId);
  }

  /** Ends a session's hold: its conversations no longer route to it. */
  detach(owner: CodexThreadOwner): void {
    if (!this.#attached.delete(owner)) return;
    for (const [threadId, current] of this.#owners) {
      if (current === owner) this.#owners.delete(threadId);
    }
    if (this.#attached.size > 0 || this.#ended) return;
    if (this.dedicated || this.#recycled) {
      void this.close();
      return;
    }
    this.#idleUnlessAttached();
  }

  #idleUnlessAttached(): void {
    if (this.#attached.size > 0 || this.#ended) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.#attached.size === 0) void this.close();
    }, codexAppServerIdleMs);
    this.#idleTimer.unref();
  }

  /**
   * Routes a conversation's frames to `owner`, those already held included,
   * in the order they arrived. One conversation has one owner at a time.
   */
  claim(threadId: string, owner: CodexThreadOwner): void {
    const current = this.#owners.get(threadId);
    if (current === owner) return;
    if (current) {
      throw new OpensteerError({
        code: "conflict",
        message: "Another Opensteer session holds this Codex conversation",
      });
    }
    this.#owners.set(threadId, owner);
    const held = this.#held.get(threadId);
    if (!held) return;
    clearTimeout(held.expiry);
    this.#held.delete(threadId);
    this.#heldBytes -= held.bytes;
    for (const message of held.frames) {
      if (this.#dispatching) this.#after.push({ message, owner });
      else this.#deliver(owner, message);
    }
  }

  owns(threadId: string, owner: CodexThreadOwner): boolean {
    return this.#owners.get(threadId) === owner;
  }

  /**
   * Unloads a conversation `owner` holds and waits until Codex says it closed:
   * only then does its next load take a new configuration, and only then is
   * whatever the conversation ran — its code-mode session included — gone.
   * False means Codex never said so.
   */
  async unload(threadId: string, owner: CodexThreadOwner, timeoutMs: number): Promise<boolean> {
    if (this.#owners.get(threadId) !== owner) return true;
    if (!this.client.failed && !this.#ended) {
      const closed = this.#closeWaiter(threadId);
      try {
        const result = await this.client.request("thread/unsubscribe", { threadId }, timeoutMs);
        const status = isRecord(result) ? optionalString(result.status) : undefined;
        if (status !== "notLoaded") {
          await withTimeout(closed.promise, timeoutMs, {
            timeoutError: () => new Error("Codex did not close the conversation"),
          });
        }
      } catch {
        return false;
      } finally {
        if (this.#closeWaiters.get(threadId) === closed) this.#closeWaiters.delete(threadId);
      }
    }
    if (this.#owners.get(threadId) === owner) this.#owners.delete(threadId);
    return true;
  }

  /**
   * No new session attaches; the process ends once its sessions have. The
   * account's sign-in changed under it, or it stopped answering in time.
   */
  recycle(): void {
    if (this.#recycled || this.#ended) return;
    this.#recycled = true;
    if (this.#attached.size === 0) void this.close();
  }

  /**
   * Ends the process now and every session on it: something one of them ran
   * could not be proven stopped any other way.
   */
  async retire(error: OpensteerError): Promise<void> {
    this.#fail(error);
    await this.close();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#end();
    clearTimeout(this.#idleTimer);
    this.#lifetime.abort(new Error("Codex app-server closed"));
    await this.client.close(this.#failure ? 0 : undefined);
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#closeWaiters.values()) waiter.resolve();
    this.#closeWaiters.clear();
    this.#onEnded?.(this);
  }

  #fail(error: OpensteerError): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#log?.("warn", "codex.app-server.failed", {
      detail: error.message,
      sessions: this.#attached.size,
    });
    const owners = [...this.#attached];
    this.#end();
    for (const owner of owners) {
      try {
        owner.serverFailed(error);
      } catch {
        // One session's teardown cannot keep the others from hearing.
      }
    }
    void this.close();
  }

  #closeWaiter(threadId: string): Deferred<void> {
    let waiter = this.#closeWaiters.get(threadId);
    if (!waiter) {
      waiter = new Deferred<void>();
      if (this.#ended) waiter.resolve();
      else this.#closeWaiters.set(threadId, waiter);
    }
    return waiter;
  }

  /**
   * Frames go out in the order they came. While Codex is asked whose a new
   * conversation is, every later frame waits for the answer: one round trip,
   * and only when a conversation appears that nothing has named.
   */
  #route(message: CodexMethodMessage, bytes: number): void {
    if (this.#pausedBy > 0) {
      this.#queued.push({ bytes, message });
      return;
    }
    this.#dispatch(message, bytes);
  }

  #resume(): void {
    this.#pausedBy -= 1;
    while (this.#pausedBy === 0 && this.#queued.length > 0) {
      const next = this.#queued.shift()!;
      this.#dispatch(next.message, next.bytes);
    }
  }

  #dispatch(message: CodexMethodMessage, bytes: number): void {
    const params = isRecord(message.params) ? message.params : undefined;
    const threadId = messageThreadId(message.method, params);
    if (message.method === "thread/closed" && threadId) {
      this.#closeWaiters.get(threadId)?.resolve();
      this.#closeWaiters.delete(threadId);
    }
    if (!threadId) {
      // Account-wide news has no conversation to go to, and no session asked.
      if (message.id !== undefined) {
        void this.client
          .respondError(message.id, -32_601, "Opensteer serves no request outside a conversation")
          .catch(() => undefined);
      }
      return;
    }
    this.#dispatching = true;
    try {
      let owner = this.#owners.get(threadId);
      if (!owner && message.method === "thread/started") {
        const parent = parentThreadId(
          params && isRecord(params.thread) ? params.thread : undefined,
        );
        const parentOwner = parent ? this.#owners.get(parent) : undefined;
        if (parentOwner) {
          this.claim(threadId, parentOwner);
          owner = parentOwner;
        }
      }
      if (owner) this.#deliver(owner, message);
      else this.#hold(threadId, message, bytes);
    } finally {
      this.#dispatching = false;
    }
    while (this.#after.length > 0) {
      const next = this.#after.shift()!;
      this.#deliver(next.owner, next.message);
    }
  }

  #deliver(owner: CodexThreadOwner, message: CodexMethodMessage): void {
    try {
      owner.receive(message);
    } catch (error) {
      this.#log?.("warn", "codex.app-server.frame-failed", {
        detail: error instanceof Error ? error.message : "unknown",
        method: message.method,
      });
    }
  }

  #hold(threadId: string, message: CodexMethodMessage, bytes: number): void {
    const now = Date.now();
    for (const [id, held] of this.#held) {
      if (now - held.firstAt <= heldFramesMaxAgeMs && this.#heldBytes + bytes <= heldFramesMaxBytes)
        break;
      this.#drop(id, held);
    }
    if (bytes > heldFramesMaxBytes) {
      this.#drop(threadId, { bytes: 0, firstAt: now, frames: [message] });
      return;
    }
    let held = this.#held.get(threadId);
    if (!held) {
      const entry: HeldFrames = { bytes: 0, firstAt: now, frames: [] };
      // A request among them must not wait on a claim that never comes.
      entry.expiry = setTimeout(() => {
        if (this.#held.get(threadId) === entry) this.#drop(threadId, entry);
      }, heldFramesMaxAgeMs);
      entry.expiry.unref();
      held = entry;
    }
    held.frames.push(message);
    held.bytes += bytes;
    this.#heldBytes += bytes;
    this.#held.set(threadId, held);
    if (this.#discovering.has(threadId)) return;
    this.#pausedBy += 1;
    void this.#discover(threadId, 0).finally(() => this.#resume());
  }

  /**
   * A subagent's frames can come before anything its Run's own conversation
   * says of it — a request for approval among them. Codex knows who spawned
   * it: the conversation goes to that one's session, its frames in order.
   */
  #discover(threadId: string, depth: number): Promise<void> {
    const running = this.#discovering.get(threadId);
    if (running) return running;
    const discovery = (async () => {
      try {
        const result = await this.client.request(
          "thread/read",
          { includeTurns: false, threadId },
          parentDiscoveryTimeoutMs,
        );
        const parent = parentThreadId(
          isRecord(result) && isRecord(result.thread) ? result.thread : undefined,
        );
        if (!parent || parent === threadId || this.#owners.has(threadId)) return;
        if (!this.#owners.has(parent) && depth < parentDiscoveryMaxDepth)
          await this.#discover(parent, depth + 1);
        const owner = this.#owners.get(parent);
        if (owner && !this.#owners.has(threadId)) this.claim(threadId, owner);
      } catch {
        // Unclaimed, its frames are dropped once they are stale.
      } finally {
        this.#discovering.delete(threadId);
      }
    })();
    this.#discovering.set(threadId, discovery);
    return discovery;
  }

  /** Frames no session claimed in time belong to no Run; a request among them is refused. */
  #drop(threadId: string, held: HeldFrames): void {
    clearTimeout(held.expiry);
    if (this.#held.get(threadId) === held) this.#held.delete(threadId);
    this.#heldBytes -= held.bytes;
    this.#log?.("warn", "codex.app-server.unclaimed-frames", { frames: held.frames.length });
    for (const frame of held.frames) {
      if (frame.id === undefined) continue;
      void this.client
        .respondError(frame.id, -32_602, "Request does not belong to an Opensteer conversation")
        .catch(() => undefined);
    }
  }
}

/** The conversation a frame is about: `thread/started` names it in its thread. */
function messageThreadId(
  method: string,
  params: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!params) return undefined;
  const direct = optionalString(params.threadId) ?? optionalString(params.conversationId);
  if (direct) return direct;
  if (method === "thread/started" && isRecord(params.thread))
    return optionalString(params.thread.id);
  return undefined;
}

/** A spawned subagent's conversation names the one that spawned it. */
function parentThreadId(thread: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!thread) return undefined;
  const direct = optionalString(thread.parentThreadId);
  if (direct) return direct;
  const source = isRecord(thread.source) ? thread.source : undefined;
  const subAgent = source && isRecord(source.subAgent) ? source.subAgent : undefined;
  const spawn = subAgent && isRecord(subAgent.thread_spawn) ? subAgent.thread_spawn : undefined;
  return spawn ? optionalString(spawn.parent_thread_id) : undefined;
}

export function assertSupportedCodexVersion(userAgent: string): void {
  // app-server intentionally brands its user agent for the invoking client in
  // some launch environments (for example `opensteer/0.154.0`) and as Codex
  // Desktop in others. The app-server version remains the first semver token.
  const version = /(?:^|\s|\/)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(userAgent)?.[1];
  if (!version || !meetsMinimumVersion(version, MINIMUM_CODEX_CLI_VERSION)) {
    throw protocolError(
      `Codex CLI ${version ?? "of an unknown version"} is older than Opensteer supports; update it to ${MINIMUM_CODEX_CLI_VERSION} or newer`,
      { details: { minimumVersion: MINIMUM_CODEX_CLI_VERSION, userAgent, version } },
    );
  }
}
