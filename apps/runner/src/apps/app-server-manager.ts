import { programEnvironment } from "@opensteer/harness";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appFolderSegments } from "@opensteer/core";
import type { AppRuntimeSpec, LocalWorkspaceBindingRef } from "@opensteer/protocol";
import type { HarnessProcessLaunchWrapper } from "@opensteer/harness";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import { stopProcessGroup } from "@opensteer/shared/processGroup";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { ProgramLaunchPlanner } from "../agent/program-executor.js";
import type { TerminationProof } from "../runtime/execution-containment.js";

interface Server {
  readonly spec: AppRuntimeSpec;
  readonly executionId: string;
  readonly child: ChildProcess;
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
  readonly resolveRoot: (
    binding: AppRuntimeSpec["binding"],
    signal: AbortSignal,
  ) => Promise<string>;
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
      const root = await this.#options.resolveRoot(spec.binding, signal);
      const resolvedRoot = await realpath(root);
      const folder = await realpath(join(resolvedRoot, ...appFolderSegments(spec.folder)));
      const childPath = relative(resolvedRoot, folder);
      if (isAbsolute(childPath) || childPath === ".." || childPath.startsWith("../"))
        throw new Error("App folder escapes outside its Workspace");
      if (!(await stat(folder)).isDirectory()) throw new Error("App folder must be a directory");
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
          workspacePath: resolvedRoot,
        });
        signal.throwIfAborted();
        if (epoch !== this.#epoch) throw new Error("App connection was lost");
        const launch = wrap({
          executable: "/bin/sh",
          args: ["-c", spec.command],
          cwd: folder,
          environment,
        });
        const child = spawn(launch.executable, [...launch.args], {
          cwd: launch.cwd,
          env: { ...launch.environment },
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
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
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
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
        child.once("error", (error) => {
          append(Buffer.from(error.message));
          exited(error);
        });
        child.once("exit", () => exited(new Error("App server exited")));
        child.once("close", () => {
          exited(new Error("App server exited"));
          finish();
        });
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
  async stopBinding(binding: LocalWorkspaceBindingRef): Promise<void> {
    // Join pending starts too: a launch may not have a server record yet.
    await Promise.all(
      [...new Set([...this.#queues.keys(), ...this.#servers.keys()])].map((appId) =>
        this.#queues.run(appId, async () => {
          const server = this.#servers.get(appId);
          const owner = server?.spec.binding;
          if (
            server &&
            owner?.bindingId === binding.bindingId &&
            owner.generation === binding.generation &&
            owner.workspaceId === binding.workspaceId &&
            owner.ownerEnvironmentId === binding.ownerEnvironmentId &&
            owner.storageAuthorityId === binding.storageAuthorityId
          )
            await this.#stop(server);
        }),
      ),
    );
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
    const proof = await this.#options.terminate(server.executionId, async () => {
      if (server.child.pid && process.platform !== "win32")
        await stopProcessGroup(server.child.pid, { graceMs: 500 });
      else if (!server.dead) server.child.kill("SIGKILL");
    });
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
