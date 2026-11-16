import { randomBytes, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { createWebSocketStream, type WebSocket } from "ws";
import type { AppId, RunnerId } from "@opensteer/core";
import type {
  AppRuntimeSpec,
  HostAppRequest,
  HostAppsSync,
  RunnerAppResult,
  RunnerAppsSyncResult,
  RunnerConnectionId,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";

export class AppTunnelError extends Error {
  readonly logTail: string;
  /** The Runner refused to treat another program's listener as this app. */
  readonly portInUse: boolean;
  constructor(message: string, logTail = "", reason?: "port_in_use") {
    super(message);
    this.logTail = logTail;
    this.portInUse = reason === "port_in_use";
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One computer's current admitted Runner connection. */
export interface AppRunnerConnection {
  readonly connectionId: RunnerConnectionId;
  /** Aborts when this connection ends. */
  readonly signal: AbortSignal;
}

/**
 * What the Runner registry provides for apps. Every request is fenced to the exact
 * connection named and fails once that connection is replaced.
 */
export interface AppRunners {
  appConnection(computerId: RunnerId): AppRunnerConnection | undefined;
  requestApp(
    computerId: RunnerId,
    connectionId: RunnerConnectionId,
    request: DistributiveOmit<HostAppRequest, "fence">,
    signal: AbortSignal,
  ): Promise<RunnerAppResult>;
  syncApps(
    computerId: RunnerId,
    connectionId: RunnerConnectionId,
    request: Omit<HostAppsSync, "fence">,
    signal: AbortSignal,
  ): Promise<RunnerAppsSyncResult>;
}

interface Ticket {
  readonly accept: (socket: WebSocket) => void;
  readonly valid: () => boolean;
}

export class AppTunnelHub {
  readonly #runners: AppRunners;
  readonly #tickets = new Map<string, Ticket>();
  readonly #streams = new Map<string, Set<Duplex>>();
  readonly #counts = new Map<string, number>();
  constructor(runners: AppRunners) {
    this.#runners = runners;
  }

  connection(computerId: RunnerId): AppRunnerConnection | undefined {
    return this.#runners.appConnection(computerId);
  }

  async start(
    connection: AppRunnerConnection,
    spec: AppRuntimeSpec,
    signal: AbortSignal,
  ): Promise<number> {
    const result = check(
      await this.#runners.requestApp(
        spec.folder.computerId,
        connection.connectionId,
        { type: "host.app.start", requestId: randomUUID(), spec },
        AbortSignal.any([signal, connection.signal]),
      ),
    );
    if (result.port !== spec.port) throw new AppTunnelError("App server answered on another port");
    return spec.port;
  }

  async stop(
    computerId: RunnerId,
    connection: AppRunnerConnection,
    appId: AppId,
    generation: number,
  ): Promise<void> {
    this.close(appId);
    check(
      await this.#runners.requestApp(
        computerId,
        connection.connectionId,
        { type: "host.app.stop", requestId: randomUUID(), appId, generation },
        AbortSignal.any([AbortSignal.timeout(30_000), connection.signal]),
      ),
    );
  }

  async sync(
    computerId: RunnerId,
    connection: AppRunnerConnection,
    apps: HostAppsSync["apps"],
  ): Promise<RunnerAppsSyncResult> {
    return this.#runners.syncApps(
      computerId,
      connection.connectionId,
      { type: "host.apps.sync", requestId: randomUUID(), apps },
      AbortSignal.any([AbortSignal.timeout(60_000), connection.signal]),
    );
  }

  /** Ends every open tunnel to this app; Stop and Delete withdraw them at once. */
  close(appId: AppId): void {
    for (const stream of this.#streams.get(appId) ?? []) stream.destroy();
    this.#streams.delete(appId);
  }

  accept(ticket: string, socket: WebSocket): void {
    const pending = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!pending || !pending.valid()) {
      socket.close(1008, "App tunnel unavailable");
      return;
    }
    pending.accept(socket);
  }

  /** Opens one exchange to the exact running spec; a connect never starts a server. */
  async connect(
    spec: AppRuntimeSpec,
    signal: AbortSignal,
  ): Promise<{ stream: Duplex; port: number }> {
    const count = this.#counts.get(spec.appId) ?? 0;
    if (count >= 64) throw new AppTunnelError("Too many requests to this app");
    const computerId = spec.folder.computerId;
    const connection = this.#runners.appConnection(computerId);
    if (!connection) throw new AppTunnelError("The app's computer is not connected");
    this.#counts.set(spec.appId, count + 1);
    const release = () => {
      const n = this.#counts.get(spec.appId) ?? 1;
      if (n <= 1) this.#counts.delete(spec.appId);
      else this.#counts.set(spec.appId, n - 1);
    };
    let retained = false;
    const ticket = randomBytes(32).toString("base64url");
    let stream: Duplex | undefined;
    const lifetime = AbortSignal.any([signal, connection.signal]);
    const setup = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
    const abort = () => stream?.destroy(new Error("App request canceled"));
    lifetime.addEventListener("abort", abort, { once: true });
    try {
      setup.throwIfAborted();
      let accept!: (socket: WebSocket) => void;
      const accepted = new Promise<Duplex>((resolve) => {
        accept = (socket) => {
          stream = createWebSocketStream(socket, { highWaterMark: 16 * 1_024 });
          stream.on("error", () => undefined);
          resolve(stream);
        };
      });
      this.#tickets.set(ticket, {
        accept,
        valid: () =>
          !setup.aborted &&
          this.#runners.appConnection(computerId)?.connectionId === connection.connectionId,
      });
      const result = check(
        await this.#runners.requestApp(
          computerId,
          connection.connectionId,
          { type: "host.app.connect", requestId: randomUUID(), spec, ticket },
          setup,
        ),
      );
      const socket = await withTimeout(accepted, 30_000, {
        signal: setup,
        timeoutError: () => new AppTunnelError("App tunnel did not connect"),
      });
      setup.throwIfAborted();
      if (result.port !== spec.port || socket.destroyed)
        throw new AppTunnelError("App tunnel was closed before it became ready");
      const streams = this.#streams.get(spec.appId) ?? new Set<Duplex>();
      streams.add(socket);
      this.#streams.set(spec.appId, streams);
      retained = true;
      socket.once("close", () => {
        lifetime.removeEventListener("abort", abort);
        release();
        streams.delete(socket);
        if (!streams.size && this.#streams.get(spec.appId) === streams)
          this.#streams.delete(spec.appId);
      });
      return { stream: socket, port: spec.port };
    } catch (error) {
      stream?.destroy();
      throw error;
    } finally {
      this.#tickets.delete(ticket);
      if (!retained) {
        lifetime.removeEventListener("abort", abort);
        release();
      }
    }
  }
}

function check(result: RunnerAppResult): RunnerAppResult {
  if (!result.ok)
    throw new AppTunnelError(result.error ?? "App server failed", result.logTail, result.reason);
  return result;
}
