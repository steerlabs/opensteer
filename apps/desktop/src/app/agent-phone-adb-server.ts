import { agentPhoneAdb, type AgentPhoneAdb } from "@opensteer/agent-phone-setup";
import {
  DesktopAgentPhoneAdbCallSchema,
  DesktopAgentPhoneAdbOpenSchema,
  DesktopAgentPhoneAdbResultSchema,
  type DesktopAgentPhoneAdbCall,
  type DesktopAgentPhoneAdbOpen,
  type DesktopAgentPhoneAdbResult,
  type DesktopAgentPhoneUsbIdentity,
} from "@opensteer/protocol/desktop";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { TransformStream } from "@yume-chan/stream-extra";
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import type { WebContents, WebFrameMain } from "electron";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";
import { agentPhoneAdbServerOwner } from "./agent-phone-adb-owner.js";

interface Connection {
  readonly adb: AgentPhoneAdb;
  close(): Promise<void>;
  readonly disconnected: Promise<unknown>;
}
interface Session {
  readonly input: DesktopAgentPhoneAdbOpen;
  readonly frame: WebFrameMain;
  readonly abort: AbortController;
  connection?: Connection;
  active: boolean;
  detach(): void;
}

/** Main owns the selected phone and sockets; the shared setup engine keeps its four-method port. */
export class AgentPhoneAdbServer {
  readonly #sessions = new Map<string, Session>();
  readonly #granted: (device: DesktopAgentPhoneUsbIdentity) => boolean;
  readonly #connect: typeof connectAgentPhoneAdbServer;

  constructor(options: {
    readonly isGranted: (device: DesktopAgentPhoneUsbIdentity) => boolean;
    readonly connect?: typeof connectAgentPhoneAdbServer;
  }) {
    this.#granted = options.isGranted;
    this.#connect = options.connect ?? connectAgentPhoneAdbServer;
  }

  async open(
    raw: DesktopAgentPhoneAdbOpen,
    frame: WebFrameMain,
    contents: WebContents,
  ): Promise<"direct" | "connected"> {
    const input = DesktopAgentPhoneAdbOpenSchema.parse(raw);
    if (!input.device.serialNumber) return "direct";
    if (!this.#granted(input.device)) throw new Error("Choose this phone before setting it up.");
    if (this.#sessions.has(input.sessionId))
      throw new Error("That phone setup session already exists.");
    for (const previous of this.#sessions.values()) {
      if (previous.frame === frame) this.#close(previous);
      else if (previous.input.device.serialNumber === input.device.serialNumber)
        throw new Error("This phone is already being set up in another window.");
    }
    const session: Session = {
      input,
      frame,
      abort: new AbortController(),
      active: false,
      detach: () => undefined,
    };
    this.#sessions.set(input.sessionId, session);
    const close = () => this.#close(session);
    const navigate = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (!details.isSameDocument && details.isMainFrame) close();
    };
    contents.once("destroyed", close);
    contents.once("render-process-gone", close);
    contents.on("did-start-navigation", navigate);
    session.detach = () => {
      contents.removeListener("destroyed", close);
      contents.removeListener("render-process-gone", close);
      contents.removeListener("did-start-navigation", navigate);
    };
    try {
      const connection = await this.#connect(input.device, session.abort.signal, () => {
        if (this.#sessions.get(input.sessionId) === session)
          frame.send(desktopBridgeChannels.agentPhoneAdbAuthorize, { sessionId: input.sessionId });
      });
      if (session.abort.signal.aborted) {
        await connection?.close();
        session.abort.signal.throwIfAborted();
      }
      if (!connection) {
        close();
        return "direct";
      }
      session.connection = connection;
      void connection.disconnected.then(close, close);
      return "connected";
    } catch (error) {
      close();
      throw error;
    }
  }

  async call(
    raw: DesktopAgentPhoneAdbCall,
    frame: WebFrameMain,
  ): Promise<DesktopAgentPhoneAdbResult> {
    const input = DesktopAgentPhoneAdbCallSchema.parse(raw);
    const session = this.#sessions.get(input.sessionId);
    if (!session || session.frame !== frame || !session.connection)
      throw new Error("The phone setup connection is closed.");
    if (!this.#granted(session.input.device)) {
      this.#close(session);
      throw new Error("Phone access was withdrawn.");
    }
    if (session.active) throw new Error("A phone setup operation is already running.");
    session.active = true;
    const { adb } = session.connection;
    const operate = async (): Promise<DesktopAgentPhoneAdbResult> => {
      switch (input.kind) {
        case "getProp":
          return { kind: input.kind, value: await adb.getProp(input.key) };
        case "shell":
          return { kind: input.kind, value: await adb.shell(input.argv) };
        case "install":
          return { kind: input.kind, value: await adb.install(input.bytes) };
        case "readFile": {
          const bytes = await adb.readFile(input.path, input.maxBytes);
          return { kind: input.kind, value: bytes === null ? null : new Uint8Array(bytes) };
        }
      }
    };
    try {
      const result = await withTimeout(operate(), input.kind === "install" ? 240_000 : 30_000, {
        signal: session.abort.signal,
        timeoutError: () => new Error("The phone did not finish the setup operation."),
      });
      session.abort.signal.throwIfAborted();
      return DesktopAgentPhoneAdbResultSchema.parse(result);
    } catch (error) {
      this.#close(session);
      throw error;
    } finally {
      session.active = false;
    }
  }

  close(sessionId: string, frame: WebFrameMain): void {
    const session = this.#sessions.get(sessionId);
    if (session?.frame === frame) this.#close(session);
  }

  revoke(device: DesktopAgentPhoneUsbIdentity): void {
    for (const session of this.#sessions.values())
      if (session.input.device.serialNumber === device.serialNumber) this.#close(session);
  }

  dispose(): void {
    for (const session of this.#sessions.values()) this.#close(session);
  }

  #close(session: Session): void {
    if (this.#sessions.get(session.input.sessionId) !== session) return;
    this.#sessions.delete(session.input.sessionId);
    session.abort.abort(new Error("The phone setup connection was closed."));
    session.detach();
    void session.connection?.close().catch(() => undefined);
  }
}

export async function connectAgentPhoneAdbServer(
  device: DesktopAgentPhoneUsbIdentity,
  signal: AbortSignal,
  onAuthorize: () => void,
  options: { readonly owner?: typeof agentPhoneAdbServerOwner; readonly port?: number } = {},
): Promise<Connection | null> {
  const owner = options.owner ?? agentPhoneAdbServerOwner;
  const generation = await owner();
  signal.throwIfAborted();
  if (!generation) return null;
  const abort = new AbortController();
  const ended = Promise.withResolvers<void>();
  abort.signal.addEventListener("abort", () => ended.resolve(), { once: true });
  const relay = () => abort.abort(signal.reason);
  signal.addEventListener("abort", relay, { once: true });
  const sockets = new Set<AdbServerClient.ServerConnection>();
  const tcp = new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: options.port ?? 5037 });
  const close = async () => {
    abort.abort(new Error("The Android debugging connection was closed."));
    signal.removeEventListener("abort", relay);
    await Promise.allSettled([...sockets].map((socket) => socket.close()));
  };
  const client = new AdbServerClient({
    connect: async (input) => {
      abort.signal.throwIfAborted();
      const socket = await tcp.connect({
        ...input,
        signal: AbortSignal.any([
          abort.signal,
          ...(input?.signal ? [input.signal as AbortSignal] : []),
        ]),
      });
      sockets.add(socket);
      void socket.closed.then(() => {
        sockets.delete(socket);
        if (input?.unref && !abort.signal.aborted) void close();
      });
      if ((await owner()) !== generation) {
        await close();
        throw new Error("The Android debugging service restarted. Choose the phone again.");
      }
      // Also bound SDK-managed replies, including package-manager installation output.
      let received = 0;
      return {
        ...socket,
        readable: socket.readable.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              received += chunk.byteLength;
              if (received > 65 * 1_024 * 1_024)
                throw new Error("The Android debugging response exceeded its size limit.");
              controller.enqueue(chunk);
            },
          }),
        ),
      };
    },
    addReverseTunnel: () => {
      throw new Error("Phone setup does not open tunnels.");
    },
    removeReverseTunnel: () => {
      throw new Error("Phone setup does not open tunnels.");
    },
    clearReverseTunnels: () => {
      throw new Error("Phone setup does not open tunnels.");
    },
  });
  try {
    return await withTimeout(
      (async () => {
        await client.validateVersion(41);
        const list = await client.createConnection("host:devices-l");
        let text: string;
        try {
          text = await list.readString();
        } finally {
          await list.dispose();
        }
        const matches = text
          .split("\n")
          .filter((line) => line.trim().split(/\s+/u)[0] === device.serialNumber);
        if (matches.length === 0) {
          await close();
          return null;
        }
        const [line] = matches;
        if (
          matches.length !== 1 ||
          !line ||
          !/\susb:\S+/u.test(line) ||
          device.serialNumber.startsWith("emulator-")
        )
          throw new Error(
            "The Android service could not identify the selected USB phone uniquely.",
          );
        const fields = line.trim().split(/\s+/u);
        const id = fields.find((field) => /^transport_id:[1-9][0-9]*$/u.test(field));
        if (!id)
          throw new Error("The Android service did not identify the phone's USB connection.");
        const transportId = BigInt(id.slice("transport_id:".length));
        if (fields[1] !== "device") {
          if (fields[1] === "unauthorized" || fields[1] === "authorizing") onAuthorize();
          await client.waitFor({ transportId }, "device", { signal: abort.signal });
        }
        const adb = await client.createAdb({ transportId });
        signal.throwIfAborted();
        void adb.disconnected.then(close, close);
        return {
          adb: agentPhoneAdb(adb),
          close,
          disconnected: Promise.race([
            adb.disconnected.then(
              () => undefined,
              () => undefined,
            ),
            ended.promise,
          ]),
        };
      })(),
      120_000,
      {
        signal,
        timeoutError: () =>
          new Error("Unlock the phone and allow USB debugging, then choose it again."),
      },
    );
  } catch (error) {
    await close();
    throw error;
  }
}
