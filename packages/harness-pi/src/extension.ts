import type { PiAccessModeGate } from "./sources.js";

/** The one Opensteer extension, written into the Thread's Runner-private state directory. */
export const piExtensionFileName = "opensteer-extension.mjs";

/**
 * The startup handshake. Pi has no way to tell a client which extensions loaded
 * — `get_commands` lists commands, not registered tools — and an extension that
 * throws while loading leaves Pi running with no gate and none of Opensteer's
 * tools (measured). So the extension says so itself through the one channel that
 * reaches the wire in RPC mode: `ctx.ui.notify`, which arrives as an
 * `extension_ui_request` (pi-facts §6). The nonce is minted per session and
 * written into the file, so an extension left over from an earlier Run cannot
 * satisfy this session's proof.
 */
export const piHandshakePrefix = "opensteer-extension-ready:";

export const piExtensionProtocolVersion = 1;

/**
 * Everything the extension asks the driver, on one channel: `ctx.ui.input`,
 * whose title is this payload. The answer is `{decision, note?}` for an
 * approval and {@link PiToolAnswer} for a tool call.
 *
 * Approvals and Opensteer tool calls share the channel because Pi gives an
 * extension exactly one way to reach its client, and because both have the same
 * shape: a question the Runner answers while the model waits.
 */
export type PiExtensionRequest =
  | {
      readonly v: typeof piExtensionProtocolVersion;
      readonly kind: "command" | "file-change";
      readonly toolCallId: string;
      readonly toolName: string;
      /** Exactly the arguments the model produced for this call. */
      readonly input: unknown;
    }
  | {
      readonly v: typeof piExtensionProtocolVersion;
      readonly kind: "tool";
      readonly arguments: unknown;
      readonly name: string;
      readonly server: string;
      readonly toolCallId: string;
    };

/**
 * One block of a tool result, in the two shapes a Pi tool result carries:
 * `AgentToolResult.content` is `(TextContent | ImageContent)[]` and Pi's image
 * block is `{data, mimeType}`, the same spelling MCP uses. The driver maps the
 * MCP result into these before the extension hands it back, so nothing Pi has
 * no place for reaches the model's transcript.
 */
export type PiToolContent =
  | { readonly text: string; readonly type: "text" }
  | { readonly data: string; readonly mimeType: string; readonly type: "image" };

/** The answer to a `kind: "tool"` request: the MCP result the driver got back. */
export interface PiToolAnswer {
  readonly content: readonly PiToolContent[];
  readonly isError: boolean;
}

/**
 * One Opensteer tool, as the driver read it from the MCP server and as the
 * extension re-declares it to Pi. No credential travels with it: the driver
 * holds the MCP connection and this is only the tool's shape.
 */
export interface PiExtensionToolDefinition {
  readonly description: string;
  /** The Host's advertised JSON Schema, passed unchanged to Pi. */
  readonly inputSchema: unknown;
  readonly name: string;
  /** `opensteer` or `opensteer_integrations`; echoed back so the driver knows where to call. */
  readonly server: string;
}

export interface PiExtensionPlan {
  readonly gate: PiAccessModeGate;
  readonly handshakeNonce: string;
  /** Re-stated on every turn of a resumed conversation through `before_agent_start`. */
  readonly machineAccessNotice: string;
  /** Every built-in Pi tool this driver was written against; anything else is blocked. */
  readonly knownTools: readonly string[];
  readonly tools: readonly PiExtensionToolDefinition[];
}

/**
 * The Opensteer extension, as source.
 *
 * Pi ships no permission system and no MCP client (pi-facts §6), so this one
 * file is the whole of Opensteer's enforcement and the whole of Opensteer's
 * tool surface:
 *
 *  - `tool_call` is the only interception point Pi has. It is fail-closed by
 *    construction: a handler that throws blocks the call
 *    (`src/core/agent-session.ts:489-508`), and so does a tool name this driver
 *    does not know.
 *  - Opensteer's tools are registered under their own names and executed by
 *    asking the driver, which holds the MCP connections. The file therefore
 *    carries no bearer token and imports no modules, so it also works in the
 *    bundled Personal runtime without a resolvable node_modules tree.
 *  - `before_agent_start` re-states the machine-access notice on every turn,
 *    including the first turn of a resumed conversation, because Pi renders the
 *    system prompt once per turn from live inputs and persists none of it
 *    (pi-facts §7).
 */
export function piExtensionSource(plan: PiExtensionPlan): string {
  const config = {
    gate: { command: [...plan.gate.commandTools], fileChange: [...plan.gate.fileChangeTools] },
    handshakeNonce: plan.handshakeNonce,
    handshakePrefix: piHandshakePrefix,
    knownTools: [...plan.knownTools],
    machineAccessNotice: plan.machineAccessNotice,
    tools: plan.tools.map((tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
      server: tool.server,
    })),
    version: piExtensionProtocolVersion,
  };
  return `// Generated by Opensteer for one Thread. Do not edit; it is rewritten every Run.
const CONFIG = ${JSON.stringify(config, undefined, 2)};

const KNOWN_TOOLS = new Set(CONFIG.knownTools);
const COMMAND_TOOLS = new Set(CONFIG.gate.command);
const FILE_CHANGE_TOOLS = new Set(CONFIG.gate.fileChange);
const OPENSTEER_TOOLS = new Set(CONFIG.tools.map((tool) => tool.name));

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\\n");
}

/** The one channel the extension has to its client, and the only one it needs. */
async function ask(ctx, request) {
  if (ctx.hasUI !== true) return undefined;
  const answer = await ctx.ui.input(JSON.stringify({ ...request, v: CONFIG.version }));
  if (typeof answer !== "string") return undefined;
  try {
    return JSON.parse(answer);
  } catch {
    return undefined;
  }
}

export default function (pi) {
  for (const tool of CONFIG.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // Pi 0.87.1 registers object schemas and validates raw JSON Schema directly.
      parameters: tool.inputSchema,
      execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
        const answer = await ask(ctx, {
          arguments: params ?? {},
          kind: "tool",
          name: tool.name,
          server: tool.server,
          toolCallId,
        });
        // Pi only marks a tool result as an error when the call throws, so a
        // failure — including Opensteer never answering — has to be thrown.
        if (!answer) throw new Error(\`Opensteer did not answer the \${tool.name} call\`);
        if (answer.isError) throw new Error(textOf(answer.content) || \`\${tool.name} failed\`);
        const content = Array.isArray(answer.content) ? answer.content : [];
        return { content: content.length > 0 ? content : [{ type: "text", text: "" }], details: {} };
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      CONFIG.handshakePrefix +
        JSON.stringify({
          hasUi: ctx.hasUI === true,
          nonce: CONFIG.handshakeNonce,
          tools: CONFIG.tools.map((tool) => tool.name),
        }),
      "info",
    );
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: \`\${event.systemPrompt}\\n\\n\${CONFIG.machineAccessNotice}\`,
  }));

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    // Opensteer's own tools are approved in every mode, as they are for Codex.
    if (OPENSTEER_TOOLS.has(toolName)) return undefined;
    const kind = COMMAND_TOOLS.has(toolName)
      ? "command"
      : FILE_CHANGE_TOOLS.has(toolName)
        ? "file-change"
        : undefined;
    if (kind === undefined) {
      if (KNOWN_TOOLS.has(toolName)) return undefined;
      // A tool this driver was not written against cannot be described to the
      // person, so it is refused rather than run unreviewed.
      return {
        block: true,
        reason: \`Opensteer does not recognise the tool \${toolName} and blocked it.\`,
      };
    }
    if (ctx.hasUI !== true) {
      return { block: true, reason: "Opensteer could not reach the person to approve this action." };
    }
    const answer = await ask(ctx, {
      input: event.input,
      kind,
      toolCallId: event.toolCallId,
      toolName,
    });
    // Cancelled, timed out, or unreadable: Pi answers \`undefined\`, and an
    // unanswered approval must never run.
    if (!answer) {
      return { block: true, reason: "Opensteer cancelled this approval before it was answered." };
    }
    if (answer.decision === "allow") return undefined;
    const note = typeof answer.note === "string" ? answer.note.trim() : "";
    return { block: true, reason: note || "Denied by the person supervising this Run" };
  });
}
`;
}
