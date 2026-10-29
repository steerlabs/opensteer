import { createServer, connect, type Server, type Socket } from "node:net";

/**
 * A TCP hop between a Runner and its Host that a test can cut.
 *
 * It forwards bytes untouched, so the Runner's WebSocket, TLS-free in tests,
 * behaves exactly as on a real network. `drop` ends every connection at once,
 * the way a lost network path does; `block` refuses new connections until
 * `unblock`, the way a partition that outlasts a reconnect attempt does.
 */
export class NetworkPartition {
  readonly #server: Server;
  readonly #connections = new Set<Socket>();
  #blocked = false;
  readonly #targetPort: number;

  private constructor(server: Server, targetPort: number) {
    this.#server = server;
    this.#targetPort = targetPort;
  }

  static async start(targetPort: number): Promise<NetworkPartition> {
    let partition!: NetworkPartition;
    const server = createServer((downstream) => partition.#accept(downstream));
    partition = new NetworkPartition(server, targetPort);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return partition;
  }

  get url(): URL {
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Partition is not listening");
    return new URL(`http://127.0.0.1:${address.port}`);
  }

  /** Ends every connection through the hop, as a lost network path would. */
  drop(): void {
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
  }

  /** Refuses connections until `unblock`, and ends the ones already open. */
  block(): void {
    this.#blocked = true;
    this.drop();
  }

  unblock(): void {
    this.#blocked = false;
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(downstream: Socket): void {
    if (this.#blocked) {
      downstream.destroy();
      return;
    }
    const upstream = connect(this.#targetPort, "127.0.0.1");
    this.#connections.add(downstream);
    this.#connections.add(upstream);
    const end = () => {
      downstream.destroy();
      upstream.destroy();
      this.#connections.delete(downstream);
      this.#connections.delete(upstream);
    };
    downstream.on("error", end);
    upstream.on("error", end);
    downstream.on("close", end);
    upstream.on("close", end);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  }
}
