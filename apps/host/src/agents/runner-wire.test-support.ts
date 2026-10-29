import type { KeyObject } from "node:crypto";
import { createServer, request } from "node:http";
import type { Socket } from "node:net";
import { RunnerChallengeSchema } from "@opensteer/protocol";
import {
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";

export const wireRecordSchema = z.object({ type: z.string() }).passthrough();
export type WireRecord = z.infer<typeof wireRecordSchema>;
export interface RunnerWireOptions {
  /**
   * Overrides the boot's advertised containment proof, to model a boot whose
   * startup could not prove an earlier boot's processes gone. Without it the
   * Runner's own advertisement passes through untouched.
   */
  readonly contained?: () => boolean;
  readonly filter?: (direction: "host" | "runner", frame: WireRecord) => boolean;
}

/** Real HTTP/WS transport, with a journal of public wire frames and explicit delivery gates. */
export class RunnerWire {
  readonly frames: { readonly direction: "host" | "runner"; readonly frame: WireRecord }[] = [];
  readonly #server;
  readonly #websockets = new WebSocketServer({ noServer: true });
  readonly #sockets = new Set<Socket>();
  readonly #connections = new Set<WebSocket>();
  readonly #options: RunnerWireOptions;
  #blocked = false;
  #keys = new Map<string, KeyObject>();
  #upstream: WebSocket | undefined;

  private constructor(port: number, options: RunnerWireOptions) {
    this.#options = options;
    this.#server = createServer((incoming, outgoing) => {
      const forwarded = request(
        {
          hostname: "127.0.0.1",
          port,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(forwarded);
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
      if (this.#blocked) socket.destroy();
    });
    this.#server.on("upgrade", (incoming, socket, head) => {
      if (this.#blocked) {
        socket.destroy();
        return;
      }
      this.#websockets.handleUpgrade(incoming, socket, head, (downstream) => {
        const upstream = new WebSocket(`ws://127.0.0.1:${port}${incoming.url}`, {
          perMessageDeflate: false,
        });
        this.#connections.add(downstream);
        this.#connections.add(upstream);
        const primary = incoming.url === "/internal/v1/runners";
        if (primary) this.#upstream = upstream;
        let challenge: z.infer<typeof RunnerChallengeSchema> | undefined;
        const pending: { readonly data: Buffer; readonly binary: boolean }[] = [];
        const forward = (destination: WebSocket, data: Buffer, binary: boolean) => {
          if (destination.readyState === WebSocket.OPEN) destination.send(data, { binary });
        };
        const frame = (direction: "host" | "runner", data: Buffer, binary: boolean) => {
          if (binary || !primary) return data;
          let value = wireRecordSchema.parse(JSON.parse(data.toString()));
          if (value.type === "host.challenge") challenge = RunnerChallengeSchema.parse(value);
          if (value.type === "runner.authenticate" || value.type === "runner.enroll") {
            if (!challenge) throw new Error("Wire proxy has no challenge");
            const descriptor = z
              .object({ capabilities: z.array(z.string()) })
              .passthrough()
              .parse(value.descriptor);
            const key = this.#keys.get(z.string().parse(descriptor.runnerId));
            if (!key) throw new Error("Wire proxy has no Runner key");
            const contained = options.contained;
            if (contained) {
              descriptor.capabilities = descriptor.capabilities.filter(
                (entry) => entry !== "earlier-boots-contained-v1",
              );
              if (contained()) descriptor.capabilities.push("earlier-boots-contained-v1");
            }
            const signature =
              value.type === "runner.authenticate"
                ? createRunnerAuthenticationSignature(key, { challenge, descriptor })
                : createRunnerEnrollmentSignature(key, {
                    challenge,
                    descriptor,
                    credential: z
                      .object({
                        kind: z.literal("host-enrollment-token"),
                        enrollmentToken: z.string(),
                      })
                      .parse(value.credential),
                    publicKeyPem: z.string().parse(value.publicKeyPem),
                  });
            value = { ...value, descriptor, signature };
          }
          this.frames.push({ direction, frame: value });
          return this.#options.filter?.(direction, value) === false
            ? null
            : Buffer.from(JSON.stringify(value));
        };
        downstream.on("message", (raw, binary) => {
          const data = frame("runner", Buffer.from(raw as Buffer), binary);
          if (!data) return;
          if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary });
          else forward(upstream, data, binary);
        });
        upstream.on("open", () => {
          for (const entry of pending.splice(0)) forward(upstream, entry.data, entry.binary);
        });
        upstream.on("message", (raw, binary) => {
          const data = frame("host", Buffer.from(raw as Buffer), binary);
          if (data) forward(downstream, data, binary);
        });
        const end = () => {
          downstream.terminate();
          upstream.terminate();
          this.#connections.delete(downstream);
          this.#connections.delete(upstream);
        };
        downstream.on("error", end);
        upstream.on("error", end);
        downstream.on("close", end);
        upstream.on("close", end);
      });
    });
  }

  static async start(port: number, options: RunnerWireOptions): Promise<RunnerWire> {
    const wire = new RunnerWire(port, options);
    await new Promise<void>((resolve) => wire.#server.listen(0, "127.0.0.1", resolve));
    return wire;
  }
  get url(): URL {
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Wire proxy is not listening");
    return new URL(`http://127.0.0.1:${address.port}`);
  }
  useKey(key: KeyObject, runnerId: string): void {
    this.#keys.set(runnerId, key);
  }
  sendRunner(frame: WireRecord): void {
    if (this.#upstream?.readyState !== WebSocket.OPEN)
      throw new Error("Runner wire is disconnected");
    this.frames.push({ direction: "runner", frame });
    this.#upstream.send(JSON.stringify(frame));
  }
  drop(): void {
    for (const socket of this.#sockets) socket.destroy();
  }
  block(): void {
    this.#blocked = true;
    this.drop();
  }
  unblock(): void {
    this.#blocked = false;
  }
  async close(): Promise<void> {
    this.drop();
    for (const connection of this.#connections) connection.terminate();
    await new Promise<void>((resolve) => this.#websockets.close(() => resolve()));
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
