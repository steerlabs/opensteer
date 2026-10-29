import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OpensteerError } from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { z } from "zod";
import type { PiExtensionToolDefinition, PiToolAnswer, PiToolContent } from "./extension.js";

/** The two Opensteer MCP servers, as the Runner names them to the model. */
export const piAgentToolsServer = "opensteer";
export const piIntegrationToolsServer = "opensteer_integrations";

/**
 * How long one Opensteer tool call may take. This is stated rather than
 * inherited: the SDK's own `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60 s
 * (`@modelcontextprotocol/sdk@1.30.0/dist/esm/shared/protocol.js`), and an
 * Opensteer tool that legitimately runs longer than that — a delegation, a
 * Workspace mount — would otherwise come back to the model as a tool error.
 * Five minutes is the Run-scoped bound; the turn's own signal is what ends a
 * call sooner, on an interrupt.
 */
export const piToolCallTimeoutMs = 5 * 60_000;

/** A `close()` that hangs must not hold the session's shutdown open. */
const piMcpCloseTimeoutMs = 5_000;

export interface PiMcpServerPlan {
  /** `opensteer` or `opensteer_integrations`. */
  readonly name: string;
  readonly token: string;
  /** The exact tool names Opensteer declares for this server; nothing else is registered. */
  readonly toolNames: readonly string[];
  readonly url: string;
}

/** The deadline and the lifetime every startup-time MCP wait is bounded by. */
export interface PiMcpConnectOptions {
  /** The session's own lifetime; an abandoned session never leaves a client open. */
  readonly signal: AbortSignal;
  /** The session startup deadline, applied to `initialize` and to `tools/list`. */
  readonly timeoutMs: number;
}

export interface PiMcpConnection {
  listTools(options: PiMcpConnectOptions): Promise<readonly PiExtensionToolDefinition[]>;
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<PiToolAnswer>;
  close(): Promise<void>;
}

/** Injected by tests that need a connection without a server. */
export type PiMcpConnect = (
  plan: PiMcpServerPlan,
  options: PiMcpConnectOptions,
) => Promise<PiMcpConnection>;

/**
 * Opensteer's tools, delivered to Pi from the Runner rather than from inside
 * the harness.
 *
 * Pi has no MCP client of its own (pi-facts §6), and the extension file it
 * would have to live in is loaded by Pi's own jiti from a Runner-private
 * directory with no `node_modules` beside it — in the packaged Personal runtime
 * there is no resolvable `@modelcontextprotocol/sdk` anywhere near it. So the
 * driver holds both connections, hands the extension only the tool *shapes*,
 * and executes every call itself. The bearer tokens never leave the Runner
 * process, which also means they never reach a file the model's own commands
 * could read (pi-facts §11).
 *
 * Every wait here is bounded. A Host that accepts the socket and never answers
 * `initialize` would otherwise hold session startup open forever, and a client
 * that failed mid-handshake has a live socket nobody holds a reference to, so
 * it is closed on the way out.
 */
export async function connectPiMcpServer(
  plan: PiMcpServerPlan,
  options: PiMcpConnectOptions,
): Promise<PiMcpConnection> {
  const client = new Client({ name: "opensteer-pi", version: "1.0.0" });
  // The SDK's own transport declares `sessionId` as a required string while
  // the interface it satisfies has it optional; every other Opensteer MCP
  // client crosses the same gap the same way.
  const transport = new StreamableHTTPClientTransport(new URL(plan.url), {
    requestInit: { headers: { Authorization: `Bearer ${plan.token}` } },
  }) as unknown as Transport;
  try {
    await raceStartupDeadline(
      client.connect(transport, {
        maxTotalTimeout: options.timeoutMs,
        signal: options.signal,
        timeout: options.timeoutMs,
      }),
      options,
      `Opensteer's ${plan.name} tools did not finish connecting`,
    );
  } catch (error) {
    await closePiMcpClient(client);
    throw toPiMcpError(error, `Opensteer's ${plan.name} tools could not be reached`);
  }
  const declared = new Set(plan.toolNames);
  return {
    callTool: async (name, args, signal) => {
      if (!declared.has(name)) {
        throw new OpensteerError({
          code: "bad_request",
          message: `${plan.name} does not offer the tool ${name}`,
        });
      }
      const result = await client.callTool(
        { arguments: (args ?? {}) as Record<string, unknown>, name },
        undefined,
        {
          maxTotalTimeout: piToolCallTimeoutMs,
          signal,
          timeout: piToolCallTimeoutMs,
        },
      );
      return { content: piToolContent(result.content), isError: result.isError === true };
    },
    close: async () => {
      await closePiMcpClient(client);
    },
    listTools: async (listOptions) => {
      let listed: Awaited<ReturnType<Client["listTools"]>>;
      try {
        listed = await raceStartupDeadline(
          client.listTools(undefined, {
            maxTotalTimeout: listOptions.timeoutMs,
            signal: listOptions.signal,
            timeout: listOptions.timeoutMs,
          }),
          listOptions,
          `Opensteer's ${plan.name} tools did not finish listing`,
        );
      } catch (error) {
        await closePiMcpClient(client);
        throw toPiMcpError(error, `Opensteer's ${plan.name} tools could not be listed`);
      }
      return listed.tools.flatMap((tool) =>
        // Only the tools Opensteer declared for this capability profile are
        // registered; a server that offered another one is not this driver's to
        // hand to the model.
        declared.has(tool.name)
          ? [
              {
                description: tool.description ?? tool.name,
                inputSchema: tool.inputSchema,
                name: tool.name,
                server: plan.name,
              },
            ]
          : [],
      );
    },
  };
}

const McpTextBlockSchema = z.looseObject({ text: z.string(), type: z.literal("text") });
const McpImageBlockSchema = z.looseObject({
  data: z.string().min(1),
  mimeType: z.string().min(1),
  type: z.literal("image"),
});

/**
 * An MCP tool result's content, in the shapes a Pi tool result carries.
 *
 * A Pi tool result holds text and images (`AgentToolResult.content` is
 * `(TextContent | ImageContent)[]`), and Pi's image block is MCP's own
 * `{data, mimeType}` pair, so a picture crosses unchanged and reaches the
 * model. MCP's other kinds — audio, embedded resources, resource links — have
 * no place in a Pi tool result and are left out rather than handed to a
 * provider serializer that has never seen them; Opensteer's own two servers
 * answer with text and images only.
 */
export function piToolContent(content: unknown): readonly PiToolContent[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): readonly PiToolContent[] => {
    const text = McpTextBlockSchema.safeParse(block);
    if (text.success) return [{ text: text.data.text, type: "text" }];
    const image = McpImageBlockSchema.safeParse(block);
    return image.success
      ? [{ data: image.data.data, mimeType: image.data.mimeType, type: "image" }]
      : [];
  });
}

/**
 * The deadline applied to a whole startup operation, not just to the requests
 * inside it. `Client.connect` sends `initialize`, then awaits the POST that
 * carries `notifications/initialized`
 * (`@modelcontextprotocol/sdk@1.30.0/dist/esm/client/index.js`), and that
 * second exchange honours none of the request options — so a Host that answers
 * `initialize` and then stalls would hold session startup open forever. The
 * whole promise is raced instead, against the deadline and the session's own
 * lifetime.
 */
async function raceStartupDeadline<T>(
  task: Promise<T>,
  options: PiMcpConnectOptions,
  failure: string,
): Promise<T> {
  return withTimeout(task, options.timeoutMs, {
    abortFallback: failure,
    signal: options.signal,
    timeoutError: () => new OpensteerError({ code: "timeout", message: failure, retryable: true }),
  });
}

/** A shutdown path never waits on a transport that has stopped answering. */
async function closePiMcpClient(client: { close(): Promise<void> }): Promise<void> {
  await withTimeout(
    client.close().catch(() => undefined),
    piMcpCloseTimeoutMs,
    { timeoutError: () => new Error("An Opensteer MCP connection did not close") },
  ).catch(() => undefined);
}

function toPiMcpError(error: unknown, fallback: string): OpensteerError {
  if (error instanceof OpensteerError) return error;
  const message = error instanceof Error ? `${fallback}: ${error.message}` : fallback;
  return new OpensteerError({ cause: error, code: "harness_error", message });
}
