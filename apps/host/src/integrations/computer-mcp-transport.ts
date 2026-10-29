import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { RunnerId } from "@opensteer/core";
import type { IntegrationServerId, LocalMcpLaunch } from "@opensteer/integration-core";
import type { HostIntegrationsMcpMessage } from "@opensteer/protocol";
import {
  ComputerMcpSessionError,
  type ComputerAppHub,
  type ComputerMcpSession,
} from "../computer-apps/computer-app-hub.js";

/**
 * The Host's MCP client transport for a server one computer runs: the
 * session is carried over that computer's `integrations` stream, and the
 * computer starts the server — or reaches it on its own loopback — only as
 * its owner approved it there. Everything above this is the same MCP client
 * every other server gets.
 */
export class ComputerMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Why the computer ended the session, when it said. */
  closeError: ComputerMcpSessionError | null = null;
  readonly #hub: Pick<ComputerAppHub, "openMcpSession">;
  readonly #target: {
    readonly launch: LocalMcpLaunch;
    readonly runnerId: RunnerId;
    readonly serverId: IntegrationServerId;
  };
  /** Aborted by `close`, ending a session the computer is still starting. */
  readonly #abandoned = new AbortController();
  #closed = false;
  #session: ComputerMcpSession | undefined;

  constructor(
    hub: Pick<ComputerAppHub, "openMcpSession">,
    target: {
      readonly launch: LocalMcpLaunch;
      readonly runnerId: RunnerId;
      readonly serverId: IntegrationServerId;
    },
  ) {
    this.#hub = hub;
    this.#target = target;
  }

  async start(): Promise<void> {
    const session = await this.#hub.openMcpSession({
      ...this.#target,
      onclose: (error) => {
        if (this.#closed) return;
        this.#closed = true;
        this.closeError = error;
        if (error) this.onerror?.(error);
        this.onclose?.();
      },
      // The computer relays what the server wrote, which the SDK parses as
      // its own message shape.
      onmessage: (message) => this.onmessage?.(message as JSONRPCMessage),
      signal: this.#abandoned.signal,
    });
    // Closed just as the computer answered that it opened: the session ends
    // now rather than outliving the client that gave it up.
    if (this.#closed) {
      await session.close();
      throw new ComputerMcpSessionError("offline", "That MCP session was closed as it opened.");
    }
    this.#session = session;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#session || this.#closed) {
      throw new ComputerMcpSessionError("offline", "That MCP session has ended.");
    }
    // The SDK builds messages with fields left `undefined`, which JSON drops:
    // what the computer is sent is the JSON the message is.
    await this.#session.send(
      JSON.parse(JSON.stringify(message)) as HostIntegrationsMcpMessage["message"],
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abandoned.abort();
    await this.#session?.close();
    this.onclose?.();
  }
}
