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
  readonly spec: AppRuntimeSpec;
  readonly executionId: string;
  readonly child: SupervisedProcess;
  readonly port: number;
  readonly closed: Promise<void>;
  readonly cleaned: Promise<void>;
  readonly finishCleanup: () => void;
  readonly abort: AbortController;
  readonly launchDirectory: string;
  log: Buffer;
  dead: boolean;
}
export class AppServerError extends Error {
  readonly logTail: string;
  constructor(message: string, logTail: string) {
    super(message);
    this.logTail = logTail;
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

export class AppServerManager {
  readonly #options: Options;
  readonly #servers = new Map<string, Server>();
  readonly #queues = new KeyedMutationQueue();
  readonly #slots = new Set<string>();
  readonly #logs = new Map<string, string>();
  #epoch = 0;
  constructor(options: Options) {
    this.#options = options;
  }

  start(spec: AppRuntimeSpec, signal = AbortSignal.timeout(30_000)): Promise<number> {
    const epoch = this.#epoch;
    return this.#queues.run(spec.appId, async () => {
      signal.throwIfAborted();
      if (epoch !== this.#epoch) throw new Error("App connection was lost");
      const previous = this.#servers.get(spec.appId);
      if (previous && previous.spec.version > spec.version)
        throw new Error("Stale app version refused");
      if (
        previous &&
        !previous.dead &&
        !previous.abort.signal.aborted &&
        JSON.stringify(previous.spec) === JSON.stringify(spec)
      )
        return previous.port;
      // Resolve and check the identity-bound root even when replacing a live server.
      const folder = await this.#options.resolveRoot(spec);
      if (previous) await this.#stop(previous);
      if (this.#slots.size >= 32) throw new Error("This Runner already has 32 app servers");
      this.#slots.add(spec.appId);
      let launchDirectory: string | undefined;
      try {
        const port = await chooseLoopbackPort();
        const environment = programEnvironment();
        environment.PORT = String(port);
        const executionId = `app:${spec.appId}:${spec.version}`;
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
        const shell = planShellLaunch(spec.command, {
          environment,
          platform: hostCommandPlatform(),
        });
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
          port,
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
        const exited = (error: Error) => {
          if (server.dead) return;
          const unexpected = !server.abort.signal.aborted;
          server.dead = true;
          server.abort.abort(error);
          void this.#queues
            .run(spec.appId, async () => {
              if (this.#servers.get(spec.appId) === server) await this.#stop(server, unexpected);
            })
            .catch((error: unknown) => {
              append(Buffer.from(error instanceof Error ? error.message : "App cleanup failed"));
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
          await waitForPort(port, readySignal);
          if (server.dead) throw new Error("App server exited");
          return port;
        } catch (error) {
          await this.#stop(server);
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
    });
  }

  logTail(appId: string): string {
    return this.#servers.get(appId)?.log.toString("utf8") ?? this.#logs.get(appId) ?? "";
  }

  exited(appId: string): Promise<void> {
    return withTimeout(this.#servers.get(appId)?.cleaned ?? Promise.resolve(), 5_000, {
      timeoutError: () => new Error("App server never exited"),
    });
  }
  stop(appId: string, version?: number): Promise<void> {
    return this.#queues.run(appId, async () => {
      this.#logs.delete(appId);
      const server = this.#servers.get(appId);
      if (server && (version === undefined || server.spec.version === version))
        await this.#stop(server);
    });
  }
  async stopAll(): Promise<void> {
    this.#epoch++;
    this.#logs.clear();
    // Abort readiness before joining queues, so a disconnected start cannot run for 30 seconds.
    for (const server of this.#servers.values())
      server.abort.abort(new Error("App connection was lost"));
    await Promise.all(
      [...new Set([...this.#queues.keys(), ...this.#servers.keys()])].map((appId) =>
        this.stop(appId),
      ),
    );
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
async function drain(stream: AsyncIterable<Buffer>, append: (chunk: Buffer) => void) {
  for await (const chunk of stream) append(chunk);
}

// The command receives PORT, so this listener must release the port before it can bind.
async function chooseLoopbackPort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("No loopback port available"));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
async function waitForPort(port: number, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    const ready = await new Promise<boolean>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, signal });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => (signal.aborted ? reject(signal.reason) : resolve(false)));
    });
    if (ready) return;
    await delay(25, undefined, { signal });
  }
}
