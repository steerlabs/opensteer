import { OpensteerError } from "@opensteer/core";
import { readBoundedJson, readBoundedText } from "@opensteer/shared/boundedJson";
import {
  spawnSupervised,
  type HarnessProcessLaunchWrapper,
  type SupervisedProcess,
} from "@opensteer/harness";
import { randomBytes } from "node:crypto";
import {
  OpencodeEventSchema,
  OpencodeHealthSchema,
  opencodeProtocolError,
  parseOpencode,
} from "./protocol.js";
import { TESTED_OPENCODE_VERSION, type OpencodeHarnessConfig } from "./config.js";

/**
 * The single line `opencode serve` prints to stdout, with or without
 * `--print-logs` (opencode-facts §1). `--port 0` means "prefer 4096, else an
 * ephemeral port", so the announced address is the only trustworthy one and the
 * driver never assumes a number it asked for.
 */
const listeningLine = /listening on\s+(https?:\/\/\S+)/iu;

/** Username OpenCode's HTTP Basic auth defaults to; `OPENCODE_SERVER_USERNAME` overrides it. */
const opencodeServerUsername = "opencode";

/** How much of a failed response is kept for the message a person reads. */
const opencodeErrorBodyMaxBytes = 64 * 1_024;

function opencodeStreamHandshakeTimeout(timeoutMs: number): OpensteerError {
  return new OpensteerError({
    code: "timeout",
    message: `OpenCode did not answer its event stream within ${timeoutMs}ms`,
    retryable: true,
  });
}

/**
 * Cold starts of two servers sharing one `opencode.db` collide: measured on
 * 1.18.31, two `opencode serve` processes launched at the same moment against a
 * fresh `XDG_DATA_HOME` both exited with "database is locked", while the same
 * two started one after the other ran happily side by side. Two Runs of one
 * account are ordinary, so startups against one data home are serialized here
 * and a lock that still escapes is reported as retryable.
 */
const dataHomeStartups = new Map<string, Promise<unknown>>();

export interface OpencodeServerOptions {
  readonly args?: readonly string[];
  readonly config: OpencodeHarnessConfig;
  readonly disableModelsFetch?: boolean;
  /** `$XDG_CONFIG_HOME`; holds the per-session `opencode/opencode.json`. */
  readonly configHome: string;
  readonly cacheHome: string;
  /** `$XDG_DATA_HOME`; holds `opencode/auth.json` and `opencode/opencode.db`. */
  readonly dataHome: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly signal?: AbortSignal;
  readonly stateHome: string;
  readonly wrapProcessLaunch?: HarnessProcessLaunchWrapper;
  readonly workingDirectory: string;
}

/**
 * The switches that keep one `opencode serve` off unsolicited network fetches and out of
 * the person's real home. Each was verified against 1.18.31 (opencode-facts §1):
 * without the two skill variables `GET /skill` returned the user's
 * `~/.claude/skills`, and without the Claude-prompt variable `~/.claude/CLAUDE.md`
 * is appended to the model's instructions.
 */
export const opencodeDisableEnvironment: Readonly<Record<string, string>> = Object.freeze({
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_SHARE: "1",
});

/**
 * One `opencode serve` process and the v1 client that talks to it.
 *
 * Everything this class puts in the process environment is readable by the
 * model: OpenCode's `bash` tool runs commands through the user's shell with the
 * server's whole environment inherited, verified live by asking a Run to print
 * it. So the environment carries locations and switches only. The one secret in
 * it is `OPENCODE_SERVER_PASSWORD`, which is minted per session and authorizes
 * nothing but this Run's own server.
 */
export class OpencodeServer {
  readonly #config: OpencodeHarnessConfig;
  readonly #process: SupervisedProcess;
  readonly #password: string;
  readonly #stderr: string[] = [];
  readonly #listening: Promise<string>;
  #settleListening!: (outcome: { readonly address: string } | { readonly error: unknown }) => void;
  #stderrBytes = 0;
  #baseUrl: string;
  #exited = false;
  #stopped = false;

  private constructor(
    config: OpencodeHarnessConfig,
    process: SupervisedProcess,
    password: string,
    baseUrl: string,
  ) {
    this.#config = config;
    this.#process = process;
    this.#password = password;
    this.#baseUrl = baseUrl;
    this.#listening = new Promise<string>((resolveAddress, rejectAddress) => {
      this.#settleListening = (outcome) => {
        if ("address" in outcome) resolveAddress(outcome.address);
        else rejectAddress(outcome.error);
      };
    });
    // A rejection nobody raced (the deadline won, say) must not take the
    // process down as an unhandled rejection.
    this.#listening.catch(() => undefined);
    void this.#process.exited.then(
      () => {
        this.#exited = true;
      },
      () => {
        this.#exited = true;
      },
    );
    this.#collectStdout();
  }

  static async start(options: OpencodeServerOptions): Promise<OpencodeServer> {
    const previous = dataHomeStartups.get(options.dataHome) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => OpencodeServer.#startOnce(options));
    dataHomeStartups.set(options.dataHome, current);
    try {
      return await current;
    } finally {
      if (dataHomeStartups.get(options.dataHome) === current) {
        dataHomeStartups.delete(options.dataHome);
      }
    }
  }

  static async #startOnce(options: OpencodeServerOptions): Promise<OpencodeServer> {
    const password = randomBytes(24).toString("base64url");
    const {
      // Background subagents would outlive the turn that started them.
      OPENCODE_EXPERIMENTAL: _experimental,
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: _backgroundSubagents,
      ...inherited
    } = options.environment ?? {};
    const environment = {
      ...inherited,
      ...opencodeDisableEnvironment,
      ...(options.disableModelsFetch ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}),
      OPENCODE_SERVER_PASSWORD: password,
      XDG_CACHE_HOME: options.cacheHome,
      XDG_CONFIG_HOME: options.configHome,
      XDG_DATA_HOME: options.dataHome,
      XDG_STATE_HOME: options.stateHome,
    };
    const launch = {
      args: [...(options.args ?? []), "serve", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: options.workingDirectory,
      environment,
      executable: options.executable,
    };
    const wrapped = options.wrapProcessLaunch ? options.wrapProcessLaunch(launch) : launch;
    const child = spawnSupervised({
      args: wrapped.args,
      cwd: wrapped.cwd,
      environment: wrapped.environment,
      executable: wrapped.executable,
      maxOutputBytes: options.config.maxStderrBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const server = new OpencodeServer(options.config, child, password, "");
    server.#collectStderr();
    try {
      server.#baseUrl = await server.#awaitListening();
      await server.#assertTestedVersion();
      return server;
    } catch (error) {
      await server.stop();
      throw error;
    }
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get stderrTail(): string {
    return this.#stderr.join("");
  }

  get exited(): SupervisedProcess["exited"] {
    return this.#process.exited;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    // A server that failed before it was usable has already gone; signalling
    // the group it no longer leads answers EPERM on macOS, which would report
    // the original failure as a failure to stop.
    if (this.#exited) return;
    // `opencode serve` has no graceful shutdown: `/global/dispose` answers true
    // and keeps running, and the process outlives its parent (opencode-facts
    // §10). Signalling the process group is the only stop, and it is also what
    // takes any lazily spawned MCP child with it.
    try {
      await this.#process.terminate(this.#config.shutdownGraceMs);
    } catch (error) {
      // A server that died between the check and the signal no longer leads
      // its group, and macOS answers that with EPERM rather than ESRCH. A stop
      // that found nothing left to stop has done its job.
      if (!(await this.#processGone())) throw error;
    }
  }

  /** Why a server that never announced an address did not. */
  #startupFailure(): string {
    const tail = this.stderrTail.trim();
    const exit =
      this.#process.child.signalCode ??
      (this.#process.child.exitCode === null ? undefined : `exit ${this.#process.child.exitCode}`);
    if (!exit) return "OpenCode did not announce a listening address";
    return `OpenCode exited before it started listening (${exit})${tail ? `: ${lastLine(tail)}` : ""}`;
  }

  async #processGone(): Promise<boolean> {
    return Promise.race([
      this.#process.exited.then(() => true),
      new Promise<boolean>((resolveGone) => {
        const timer = setTimeout(() => resolveGone(false), 1_000);
        timer.unref?.();
      }),
    ]).catch(() => true);
  }

  /** One v1 request. `directory` is a query parameter on every v1 route, not a body field. */
  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: {
      readonly body?: unknown;
      readonly directory?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const response = await this.#fetch(method, path, options);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new OpensteerError({
        code: "not_found",
        message: `OpenCode has no ${path.split("?")[0] ?? path}`,
      });
    }
    // Every body is read through the shared bounded readers: a response is
    // foreign input even from a server this process started, and one that never
    // ends would otherwise be buffered whole.
    if (!response.ok) {
      const detail = await readBoundedText(response, {
        maximumBytes: opencodeErrorBodyMaxBytes,
        sizeError: () => new Error("truncated"),
      }).catch(() => "");
      throw opencodeProtocolError(
        `OpenCode answered HTTP ${response.status} for ${method} ${path.split("?")[0] ?? path}`,
        { details: { detail: detail.slice(0, 2_000) } },
      );
    }
    return readBoundedJson(response, {
      emptyValue: undefined,
      invalidJsonError: (cause) =>
        opencodeProtocolError("OpenCode answered with invalid JSON", { cause }),
      maximumBytes: this.#config.maxResponseBytes,
      sizeError: () =>
        opencodeProtocolError(
          `OpenCode answered ${method} ${path.split("?")[0] ?? path} beyond the configured response limit`,
        ),
    }).catch((error: unknown) => {
      // A 204 has no body at all, which is what `prompt_async` and the saved
      // permission delete answer with.
      if (error instanceof SyntaxError) return undefined;
      throw error;
    });
  }

  /**
   * The v1 event stream. Opening it is a separate step from consuming it so a
   * caller can be sure the subscription exists before it prompts: the stream
   * carries the whole turn, and one admitted with nobody listening is lost.
   *
   * It carries every session the server holds, so callers filter by session id;
   * this driver runs one session per server and still filters, because a
   * resumed conversation shares the profile's database with whatever else the
   * person has there.
   */
  async openEvents(options: {
    readonly directory: string;
    readonly signal: AbortSignal;
  }): Promise<AsyncIterable<{ readonly type: string; readonly properties: unknown }>> {
    // The body is a stream with no end, so it must not carry a request
    // deadline — but the wait for its response headers must, or a server that
    // accepts the connection and never answers holds the session open forever.
    // The handshake timer is cleared the moment the headers arrive; only the
    // session's own signal reaches the body.
    const handshake = new AbortController();
    const timer = setTimeout(
      () => handshake.abort(opencodeStreamHandshakeTimeout(this.#config.requestTimeoutMs)),
      this.#config.requestTimeoutMs,
    );
    timer.unref?.();
    let response: Response;
    try {
      response = await this.#fetch("GET", "/event", {
        accept: "text/event-stream",
        directory: options.directory,
        handshakeSignal: handshake.signal,
        signal: options.signal,
      });
    } catch (error) {
      if (handshake.signal.aborted) throw handshake.signal.reason as Error;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw opencodeProtocolError(`OpenCode event stream answered HTTP ${response.status}`);
    }
    return this.#readEvents(response.body);
  }

  async *#readEvents(
    body: ReadableStream<Uint8Array>,
  ): AsyncIterable<{ readonly type: string; readonly properties: unknown }> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        // The raw line is what arrived, so the raw line is what is bounded:
        // checking only the residual buffer would let an oversized line that
        // happens to end in a newline through, and trimming first would let one
        // padded out with whitespace through the same way.
        this.#assertEventLineBytes(raw);
        const line = raw.trimEnd();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload) as unknown;
        } catch (error) {
          throw opencodeProtocolError("OpenCode emitted an invalid event", { cause: error });
        }
        const event = parseOpencode(OpencodeEventSchema, parsed, "event");
        yield { properties: event.properties, type: event.type };
      }
      this.#assertEventLineBytes(buffer);
    }
  }

  #assertEventLineBytes(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.#config.maxEventLineBytes) {
      throw opencodeProtocolError("OpenCode emitted an event line beyond the configured limit");
    }
  }

  async #fetch(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: {
      readonly accept?: string;
      readonly body?: unknown;
      readonly directory?: string;
      /** Bounds the response-header wait only; the streaming body outlives it. */
      readonly handshakeSignal?: AbortSignal;
      readonly signal?: AbortSignal;
    },
  ): Promise<Response> {
    const url = new URL(path, this.#baseUrl);
    if (options.directory !== undefined) url.searchParams.set("directory", options.directory);
    const timeout = options.handshakeSignal
      ? options.handshakeSignal
      : AbortSignal.timeout(this.#config.requestTimeoutMs);
    const signals = [options.signal, timeout].filter((value): value is AbortSignal =>
      Boolean(value),
    );
    return fetch(url, {
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      headers: {
        accept: options.accept ?? "application/json",
        authorization: `Basic ${Buffer.from(`${opencodeServerUsername}:${this.#password}`, "utf8").toString("base64")}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
  }

  async #awaitListening(): Promise<string> {
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new OpensteerError({
              code: "timeout",
              message: `OpenCode did not start listening within ${this.#config.startupTimeoutMs}ms`,
              retryable: true,
            }),
          ),
        this.#config.startupTimeoutMs,
      );
      timer.unref?.();
    });
    const exit = this.#process.exited.then(({ code, signal }) => {
      throw new OpensteerError({
        code: "harness_error",
        // A cold-start collision on one profile's database is transient, and
        // the serialization above is only in-process.
        retryable: this.stderrTail.includes("database is locked"),
        message: `OpenCode exited before it started listening (${signal ?? `exit ${code ?? "unknown"}`})${
          this.stderrTail.trim() ? `: ${lastLine(this.stderrTail)}` : ""
        }`,
      });
    });
    return Promise.race([this.#listening, deadline, exit]);
  }

  /**
   * The one consumer of the server's stdout. It keeps reading after the
   * listening line so the child never stalls on a pipe nobody drains, and it
   * is started once: two iterations of one async generator deadlock each other.
   */
  #collectStdout(): void {
    void (async () => {
      let buffer = "";
      let announced = false;
      try {
        for await (const chunk of this.#process.stdout) {
          if (announced) continue;
          buffer += chunk.toString("utf8");
          const match = listeningLine.exec(buffer);
          if (match?.[1]) {
            announced = true;
            buffer = "";
            this.#settleListening({ address: match[1] });
            continue;
          }
          if (buffer.length > 64 * 1_024) {
            announced = true;
            buffer = "";
            this.#settleListening({
              error: opencodeProtocolError("OpenCode did not announce a listening address"),
            });
          }
        }
      } catch (error) {
        this.#settleListening({ error });
        return;
      }
      if (announced) return;
      // stdout ending without the line almost always means the process died.
      // Its exit status and stderr say why, so they are given a moment to
      // arrive rather than reporting the silence they caused.
      await this.#processGone();
      this.#settleListening({
        error: opencodeProtocolError(this.#startupFailure()),
      });
    })();
  }

  #collectStderr(): void {
    void (async () => {
      try {
        for await (const chunk of this.#process.stderr) {
          if (this.#stderrBytes >= this.#config.maxStderrBytes) continue;
          this.#stderrBytes += chunk.byteLength;
          this.#stderr.push(chunk.toString("utf8"));
        }
      } catch {
        // The stream ends with the process.
      }
    })();
  }

  async #assertTestedVersion(): Promise<void> {
    const health = parseOpencode(
      OpencodeHealthSchema,
      await this.request("GET", "/global/health"),
      "global health",
    );
    if (health.version !== TESTED_OPENCODE_VERSION) {
      throw opencodeProtocolError(
        `Unsupported OpenCode version ${health.version}; this adapter is pinned to ${TESTED_OPENCODE_VERSION}`,
        { details: { testedVersion: TESTED_OPENCODE_VERSION, version: health.version } },
      );
    }
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines.at(-1) ?? "").slice(0, 500);
}
