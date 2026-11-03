import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createCredentialResponseRedactor,
  type CredentialResponseRedactor,
} from "@opensteer/access/host";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { RunnerId } from "@opensteer/core";
import type { IntegrationServerId, LocalMcpLaunch } from "@opensteer/integration-core";
import { computerMcpLastOutputLabel, type HostIntegrationsMcpMessage } from "@opensteer/protocol";
import {
  ComputerMcpSessionError,
  type ComputerAppHub,
  type ComputerMcpSession,
} from "../computer-apps/computer-app-hub.js";

/**
 * The Host's MCP client transport for a server one computer runs: the
 * session is carried over that computer's `integrations` stream, and the
 * computer starts the server — or reaches it on its own loopback — only as
 * its owner approved through the Host. Everything above this is the same MCP client
 * every other server gets.
 */
export class ComputerMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Why the computer ended the session, when it said. */
  closeError: ComputerMcpSessionError | null = null;
  readonly #hub: Pick<ComputerAppHub, "openMcpSession" | "withRunnerAdmission">;
  readonly #target: {
    readonly authorize: () => Promise<void>;
    readonly launch: LocalMcpLaunch;
    readonly runnerId: RunnerId;
    /** What its launch's secrets were given, which the computer starts it with. */
    readonly secrets: Readonly<Record<string, string>>;
    readonly serverId: IntegrationServerId;
  };
  readonly #redactor: CredentialResponseRedactor;
  /** Aborted by `close`, ending a session the computer is still starting. */
  readonly #abandoned = new AbortController();
  #closed = false;
  #session: ComputerMcpSession | undefined;

  constructor(
    hub: Pick<ComputerAppHub, "openMcpSession" | "withRunnerAdmission">,
    target: {
      readonly authorize: () => Promise<void>;
      readonly launch: LocalMcpLaunch;
      readonly runnerId: RunnerId;
      readonly secrets: Readonly<Record<string, string>>;
      readonly serverId: IntegrationServerId;
    },
  ) {
    this.#hub = hub;
    this.#target = target;
    this.#redactor = createCredentialResponseRedactor(Object.values(target.secrets));
  }

  async start(): Promise<void> {
    const admitted = await this.#hub.withRunnerAdmission(this.#target.runnerId, async () => {
      this.#abandoned.signal.throwIfAborted();
      await this.#target.authorize();
      this.#abandoned.signal.throwIfAborted();
      return {
        opening: this.#hub.openMcpSession({
          launch: this.#target.launch,
          runnerId: this.#target.runnerId,
          secrets: this.#target.secrets,
          serverId: this.#target.serverId,
          onclose: (error) => {
            if (this.#closed) return;
            this.#closed = true;
            this.closeError = error && this.#withoutSecrets(error);
            if (this.closeError) this.onerror?.(this.closeError);
            this.onclose?.();
          },
          // The computer relays what the server wrote, which the SDK parses as
          // its own message shape.
          onmessage: (message) => this.onmessage?.(message as JSONRPCMessage),
          signal: this.#abandoned.signal,
        }),
      };
    });
    const session = await admitted.opening.catch((error: unknown) => {
      throw error instanceof ComputerMcpSessionError ? this.#withoutSecrets(error) : error;
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

  /**
   * Why the computer ended a session can quote what the server wrote, which
   * the Host stores as its status and tells agents: never with its secrets.
   */
  #withoutSecrets(error: ComputerMcpSessionError): ComputerMcpSessionError {
    let message = this.#redactor.redactText(error.message);
    // The computer cut the output just after its label, perhaps within a
    // secret: whatever that output starts with of one's end goes too.
    const label = message.indexOf(computerMcpLastOutputLabel);
    if (label >= 0) {
      const start = label + computerMcpLastOutputLabel.length;
      const output = message.slice(start);
      const cut = Math.max(
        0,
        ...Object.values(this.#target.secrets).map((secret) => splitSecretEnd(secret, output)),
      );
      if (cut > 0) message = `${message.slice(0, start)}…${output.slice(cut)}`;
    }
    return message === error.message ? error : new ComputerMcpSessionError(error.code, message);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abandoned.abort();
    await this.#session?.close();
    this.onclose?.();
  }
}

/** How much of `text`'s start is the end of `secret`. */
function splitSecretEnd(secret: string, text: string): number {
  for (let length = Math.min(secret.length, text.length); length > 0; length -= 1) {
    if (text.startsWith(secret.slice(-length))) return length;
  }
  return 0;
}
