import { programEnvironment, spawnSupervised, type SupervisedProcess } from "@opensteer/harness";
import { hostCommandPlatform, planShellLaunch } from "@opensteer/shared/command";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AppRuntimeSpec } from "@opensteer/protocol";
import type { HarnessProcessLaunchWrapper } from "@opensteer/harness";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { ProgramLaunchPlanner } from "../agent/program-executor.js";
import type { TerminationProof } from "../runtime/execution-containment.js";

interface Server {
  spec: AppRuntimeSpec;
  readonly executionId: string;
  readonly child: SupervisedProcess;
  readonly closed: Promise<void>;
  readonly cleaned: Promise<void>;
  readonly finishCleanup: () => void;
  readonly abort: AbortController;
  readonly launchDirectory: string;
  log: Buffer;
  dead: boolean;
}
export interface AppServerState {
  readonly appId: string;
  readonly version: number;
  readonly generation: number;
  readonly state: "running" | "stopped" | "failed";
  readonly error?: string;
}
export class AppServerError extends Error {
  readonly logTail: string;
  readonly reason: "port_in_use" | undefined;
  constructor(message: string, logTail: string, reason?: "port_in_use") {
    super(message);
    this.logTail = logTail;
    this.reason = reason;
  }
}
interface Options {
  readonly resolveRoot: (spec: AppRuntimeSpec) => Promise<string>;
  readonly planLaunch: (
    executionId: string,
    launch: Parameters<ProgramLaunchPlanner>[0],
  ) => Promise<HarnessProcessLaunchWrapper>;
  readonly terminate: (
    executionId: string,
    stopEngine: () => Promise<unknown>,
  ) => Promise<TerminationProof>;
  readonly readyTimeoutMs?: number;
  readonly privateDirectory?: string;
}

/**
 * Supervises app servers on their Host-assigned fixed ports. Generations fence every
 * request: once a generation is stopped, no start at or below it runs again until the
 * Host connection that issued them ends.
 */
export class AppServerManager {
  readonly #options: Options;
  readonly #servers = new Map<string, Server>();
  readonly #queues = new KeyedMutationQueue();
  readonly #slots = new Set<string>();
  readonly #logs = new Map<string, string>();
  readonly #stopped = new Map<string, number>();
  readonly #starting = new Map<string, { generation: number; abort: AbortController }>();
  readonly #listeners = new Set<(state: AppServerState) => void>();
  #epoch = 0;
  constructor(options: Options) {
    this.#options = options;
  }

  /** Every change of actual state, including exits nobody asked for. */
  observe(listener: (state: AppServerState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts the exact spec, or returns its port if it already runs. */
  start(spec: AppRuntimeSpec, signal = AbortSignal.timeout(30_000)): Promise<number> {
    const epoch = this.#epoch;
    try {
      this.#refuseStale(spec);
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = { generation: spec.generation, abort: new AbortController() };
    const previous = this.#starting.get(spec.appId);
    if (!previous || previous.generation <= spec.generation)
      this.#starting.set(spec.appId, pending);
    const startSignal = AbortSignal.any([signal, pending.abort.signal]);
    return this.#queues
      .run(spec.appId, async () => {
        startSignal.throwIfAborted();
        if (epoch !== this.#epoch) throw new Error("App connection was lost");
        this.#refuseStale(spec);
        const current = this.#servers.get(spec.appId);
        if (current && current.spec.generation > spec.generation)
          throw new Error("A newer app generation replaced this start");
        if (
          current &&
          !current.dead &&
          !current.abort.signal.aborted &&
          sameRuntime(current.spec, spec)
        ) {
          current.spec = spec;
          this.#emit({ ...identity(spec), state: "running" });
          return spec.port;
        }
        return this.#launch(spec, startSignal, epoch, current);
      })
      .catch((error: unknown) => {
        if (!(error instanceof StaleStartError))
          this.#emit({
            ...identity(spec),
            state: "failed",
            error: error instanceof Error ? error.message : "App server failed",
          });
        throw error;
      })
      .finally(() => {
        if (this.#starting.get(spec.appId) === pending) this.#starting.delete(spec.appId);
      });
  }

  /** The exact current spec is running; connecting never starts a server. */
  running(spec: AppRuntimeSpec): boolean {
    const server = this.#servers.get(spec.appId);
    return (
      !!server &&
      !server.dead &&
      !server.abort.signal.aborted &&
      server.spec.generation === spec.generation &&
      sameRuntime(server.spec, spec)
    );
  }

  logTail(appId: string): string {
    return this.#servers.get(appId)?.log.toString("utf8") ?? this.#logs.get(appId) ?? "";
  }

  exited(appId: string): Promise<void> {
    return withTimeout(this.#servers.get(appId)?.cleaned ?? Promise.resolve(), 5_000, {
      timeoutError: () => new Error("App server never exited"),
    });
  }

  /** Stops this app at or below `generation` and refuses any later start up to it. */
  stop(appId: string, generation: number): Promise<void> {
    this.#stopped.set(appId, Math.max(this.#stopped.get(appId) ?? 0, generation));
    // Abort readiness before joining the queue, so a pending start cannot hold Stop for 30 seconds.
    const pending = this.#starting.get(appId);
    if (pending && pending.generation <= generation)
      pending.abort.abort(new StaleStartError("App server stopped"));
    return this.#queues.run(appId, async () => {
      this.#logs.delete(appId);
      const server = this.#servers.get(appId);
      if (!server || server.spec.generation > generation) return;
      await this.#stop(server);
      this.#emit({ appId, version: server.spec.version, generation, state: "stopped" });
    });
  }

  /**
   * Makes manager entries match the Host's complete set: absent and stopped apps stop
   * first, then each desired running app gets one start attempt. Rejects only when a
   * stop could not prove its process tree gone.
   */
  async sync(
    apps: ReadonlyArray<{
      readonly spec: AppRuntimeSpec;
      readonly desiredState: "running" | "stopped";
    }>,
    signal: AbortSignal,
  ): Promise<void> {
    const wanted = new Map(apps.map((app) => [app.spec.appId, app]));
    const stops: Promise<void>[] = [];
    for (const appId of new Set([...this.#servers.keys(), ...this.#starting.keys()])) {
      const entry = Math.max(
        this.#servers.get(appId)?.spec.generation ?? 0,
        this.#starting.get(appId)?.generation ?? 0,
      );
      const app = wanted.get(appId);
      if (!app) stops.push(this.stop(appId, entry));
      else if (app.desiredState === "stopped") stops.push(this.stop(appId, app.spec.generation));
    }
    for (const app of apps)
      if (app.desiredState === "stopped" && !this.#servers.has(app.spec.appId))
        this.#stopped.set(
          app.spec.appId,
          Math.max(this.#stopped.get(app.spec.appId) ?? 0, app.spec.generation),
        );
    const stopped = await Promise.allSettled(stops);
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    await Promise.allSettled(
      apps
        .filter((app) => app.desiredState === "running")
        .map((app) => this.start(app.spec, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))),
    );
  }

  /** The Host connection ended: stop everything and forget its generation fences. */
  async stopAll(): Promise<void> {
    this.#epoch++;
    this.#logs.clear();
    this.#stopped.clear();
    // Abort readiness before joining queues, so a disconnected start cannot run for 30 seconds.
    for (const pending of this.#starting.values())
      pending.abort.abort(new Error("App connection was lost"));
    for (const server of this.#servers.values())
      server.abort.abort(new Error("App connection was lost"));
    await Promise.all(
      [...new Set([...this.#queues.keys(), ...this.#servers.keys()])].map((appId) =>
        this.#queues.run(appId, async () => {
          const server = this.#servers.get(appId);
          if (server) await this.#stop(server);
        }),
      ),
    );
  }

  async #launch(
    spec: AppRuntimeSpec,
    signal: AbortSignal,
    epoch: number,
    previous: Server | undefined,
  ): Promise<number> {
    // Resolve and check the identity-bound root even when replacing a live server.
    const folder = await this.#options.resolveRoot(spec);
    if (previous) await this.#stop(previous);
    if (this.#slots.size >= 32) throw new Error("This Runner already has 32 app servers");
    this.#slots.add(spec.appId);
    let launchDirectory: string | undefined;
    try {
      // Never treat a foreign listener as this app, and never kill it.
      if (await portInUse(spec.port, signal))
        throw new AppServerError(
          `Port ${spec.port} is in use by another program on this computer. Stop that program, then start the app again.`,
          "",
          "port_in_use",
        );
      const environment = programEnvironment();
      environment.PORT = String(spec.port);
      const executionId = `app:${spec.appId}:${spec.generation}`;
      const privateRoot =
        this.#options.privateDirectory ?? join(tmpdir(), "opensteer-app-launches");
      await mkdir(privateRoot, { recursive: true, mode: 0o700 });
      launchDirectory = await mkdtemp(join(privateRoot, "app-"));
      const wrap = await this.#options.planLaunch(executionId, {
        environment,
        privateDirectory: launchDirectory,
        workspacePath: folder,
      });
      signal.throwIfAborted();
      if (epoch !== this.#epoch) throw new Error("App connection was lost");
      const shell = planShellLaunch(spec.command, { environment, platform: hostCommandPlatform() });
      const launch = wrap({
        executable: shell.executable,
        args: shell.args,
        cwd: folder,
        environment,
      });
      const child = spawnSupervised({
        ...launch,
        output: "raw",
        stdin: "closed",
        ...(shell.windowsCommandLine ? { windowsCommandLine: shell.windowsCommandLine } : {}),
      });
      let finish!: () => void;
      const cleanup = Promise.withResolvers<void>();
      this.#logs.delete(spec.appId);
      const server: Server = {
        spec,
        executionId,
        child,
        launchDirectory,
        abort: new AbortController(),
        log: Buffer.alloc(0),
        closed: new Promise((resolve) => {
          finish = resolve;
        }),
        cleaned: cleanup.promise,
        finishCleanup: cleanup.resolve,
        dead: false,
      };
      this.#servers.set(spec.appId, server);
      const append = (chunk: Buffer) => {
        server.log = Buffer.from(Buffer.concat([server.log, chunk]).subarray(-16 * 1_024));
      };
      let ready = false;
      const exited = (error: Error) => {
        if (server.dead) return;
        const unexpected = !server.abort.signal.aborted;
        server.dead = true;
        server.abort.abort(error);
        void this.#queues
          .run(spec.appId, async () => {
            if (this.#servers.get(spec.appId) !== server) return;
            await this.#stop(server, unexpected);
            // A crash after readiness is reported here; a failed start reports itself.
            if (unexpected && ready)
              this.#emit({ ...identity(server.spec), state: "failed", error: error.message });
          })
          .catch((cleanupError: unknown) => {
            append(
              Buffer.from(
                cleanupError instanceof Error ? cleanupError.message : "App cleanup failed",
              ),
            );
          });
      };
      // The supervisor exits once nothing of the server's tree is left.
      const ended = child.exited.then(
        () => exited(new Error("App server exited")),
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error("App server failed");
          append(Buffer.from(failure.message));
          exited(failure);
        },
      );
      // A failed read ends the log, never the cleanup that waits on it.
      const read = (stream: AsyncIterable<Buffer>) =>
        drain(stream, append).catch((error: unknown) => {
          append(Buffer.from(error instanceof Error ? error.message : "App output was lost"));
        });
      void Promise.all([ended, read(child.stdout), read(child.stderr)]).then(() => finish());
      const readySignal = AbortSignal.any([
        signal,
        server.abort.signal,
        AbortSignal.timeout(this.#options.readyTimeoutMs ?? 28_000),
      ]);
      try {
        await waitForPort(spec.port, readySignal);
        if (server.dead) throw new Error("App server exited");
        ready = true;
        this.#emit({ ...identity(server.spec), state: "running" });
        return spec.port;
      } catch (error) {
        await this.#stop(server);
        if (signal.reason instanceof StaleStartError) throw signal.reason;
        throw new AppServerError(
          error instanceof Error ? error.message : "App server did not become ready",
          server.log.toString("utf8"),
        );
      }
    } finally {
      if (launchDirectory && this.#servers.get(spec.appId)?.launchDirectory !== launchDirectory)
        await rm(launchDirectory, { recursive: true, force: true });
      if (!this.#servers.has(spec.appId)) this.#slots.delete(spec.appId);
    }
  }

  #refuseStale(spec: AppRuntimeSpec): void {
    if (spec.generation <= (this.#stopped.get(spec.appId) ?? 0))
      throw new StaleStartError("This app was stopped after the start was requested");
  }

  #emit(state: AppServerState): void {
    for (const listener of this.#listeners) listener(state);
  }

  async #stop(server: Server, retainLog = false): Promise<void> {
    server.abort.abort(new Error("App server stopped"));
    const proof = await this.#options.terminate(server.executionId, () =>
      server.child.terminate(500),
    );
    if (proof === "unknown")
      throw new AppServerError(
        `Cannot prove app server ${server.spec.appId} stopped; retry stopping it before restarting`,
        server.log.toString("utf8"),
      );
    await withTimeout(server.closed, 5_000, {
      timeoutError: () => new Error("App server did not stop"),
    });
    await rm(server.launchDirectory, { recursive: true, force: true });
    if (this.#servers.get(server.spec.appId) === server) {
      if (retainLog && server.log.length)
        this.#logs.set(server.spec.appId, server.log.toString("utf8"));
      this.#servers.delete(server.spec.appId);
      this.#slots.delete(server.spec.appId);
    }
    server.finishCleanup();
  }
}

/** A start superseded by Stop, Delete or a newer generation; it reports no failure. */
export class StaleStartError extends Error {}

function identity(spec: AppRuntimeSpec) {
  return { appId: spec.appId, version: spec.version, generation: spec.generation };
}

function sameRuntime(left: AppRuntimeSpec, right: AppRuntimeSpec): boolean {
  return (
    left.version === right.version &&
    left.port === right.port &&
    left.command === right.command &&
    left.folder.computerId === right.folder.computerId &&
    left.folder.path === right.folder.path &&
    left.agentHome.path === right.agentHome.path
  );
}

async function drain(stream: AsyncIterable<Buffer>, append: (chunk: Buffer) => void) {
  for await (const chunk of stream) append(chunk);
}

/** Another program owns the port if it accepts loopback connections or holds the bind. */
async function portInUse(port: number, signal: AbortSignal): Promise<boolean> {
  if (await accepts(port, signal)) return true;
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" || error.code === "EACCES" ? resolve(true) : reject(error),
    );
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      probe.close((error) => (error ? reject(error) : resolve(false))),
    );
  });
}

function accepts(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, signal });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => (signal.aborted ? reject(signal.reason) : resolve(false)));
  });
}

async function waitForPort(port: number, signal: AbortSignal): Promise<void> {
  while (!(await accepts(port, signal))) await delay(25, undefined, { signal });
}
