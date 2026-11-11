import { randomBytes, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { createWebSocketStream, type WebSocket } from "ws";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { AppRuntimeSpec, RunnerAppResult } from "@opensteer/protocol";
import { sameRunnerConnectionFence } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";

export class AppTunnelError extends Error {
  readonly logTail: string;
  constructor(message: string, logTail = "") {
    super(message);
    this.logTail = logTail;
  }
}
type Runners = Pick<
  RunnerRegistry,
  "identityForEnvironment" | "identityForRunner" | "requestApp" | "appConnectionSignal"
>;
interface Ticket {
  readonly accept: (socket: WebSocket) => void;
  readonly valid: () => boolean;
}
export class AppTunnelHub {
  readonly #runners: Runners;
  readonly #tickets = new Map<string, Ticket>();
  readonly #counts = new Map<string, number>();
  constructor(runners: Runners) {
    this.#runners = runners;
  }
  async start(spec: AppRuntimeSpec, signal: AbortSignal): Promise<void> {
    check(
      await this.#runners.requestApp(
        this.#environment(spec),
        { type: "host.app.start", requestId: randomUUID(), spec },
        signal,
      ),
    );
  }
  async stop(spec: AppRuntimeSpec): Promise<void> {
    check(
      await this.#runners.requestApp(
        this.#environment(spec),
        { type: "host.app.stop", requestId: randomUUID(), spec },
        AbortSignal.timeout(30_000),
      ),
    );
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
  async connect(
    spec: AppRuntimeSpec,
    signal: AbortSignal,
  ): Promise<{ stream: Duplex; port: number }> {
    const count = this.#counts.get(spec.appId) ?? 0;
    if (count >= 64) throw new AppTunnelError("Too many requests to this app");
    this.#counts.set(spec.appId, count + 1);
    const release = () => {
      const n = this.#counts.get(spec.appId) ?? 1;
      if (n <= 1) this.#counts.delete(spec.appId);
      else this.#counts.set(spec.appId, n - 1);
    };
    const ticket = randomBytes(32).toString("base64url");
    const environmentId = this.#environment(spec);
    const identity = this.#runners.identityForEnvironment(environmentId);
    let stream: Duplex | undefined;
    let releaseOnClose = false;
    const connectionSignal = identity
      ? this.#runners.appConnectionSignal(environmentId, identity.connectionId)
      : AbortSignal.abort();
    const lifetime = AbortSignal.any([signal, connectionSignal]);
    const setup = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
    const abort = () => stream?.destroy(new Error("App request canceled"));
    lifetime.addEventListener("abort", abort, { once: true });
    try {
      setup.throwIfAborted();
      if (!identity) throw new AppTunnelError("The app's computer is not connected");
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
        valid: () => {
          const current = this.#runners.identityForEnvironment(environmentId);
          return (
            !setup.aborted && !!current && sameRunnerConnectionFence(current.fence, identity.fence)
          );
        },
      });
      const result = await this.#runners.requestApp(
        environmentId,
        { type: "host.app.connect", requestId: randomUUID(), spec, ticket },
        setup,
      );
      check(result);
      const socket = await withTimeout(accepted, 30_000, {
        signal: setup,
        timeoutError: () => new AppTunnelError("App tunnel did not connect"),
      });
      setup.throwIfAborted();
      if (!result.port || socket.destroyed)
        throw new AppTunnelError("App tunnel was closed before it became ready");
      releaseOnClose = true;
      socket.once("close", () => {
        lifetime.removeEventListener("abort", abort);
        release();
      });
      return { stream: socket, port: result.port };
    } catch (error) {
      stream?.destroy();
      throw error;
    } finally {
      this.#tickets.delete(ticket);
      if (!releaseOnClose) {
        lifetime.removeEventListener("abort", abort);
        release();
      }
    }
  }
  #environment(spec: AppRuntimeSpec) {
    const identity = this.#runners.identityForRunner(spec.folder.computerId);
    const environmentId = identity?.environmentIds[0];
    if (!environmentId) throw new AppTunnelError("The app's computer is not connected");
    return environmentId;
  }
}
function check(result: RunnerAppResult): void {
  if (!result.ok) throw new AppTunnelError(result.error ?? "App server failed", result.logTail);
}
