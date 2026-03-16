import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ImageContent,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  OPENSTEER_PROTOCOL_VERSION,
  type OpensteerComputerExecuteOutput,
  assertValidSemanticOperationInput,
  opensteerMcpTools,
  type OpensteerMcpToolDescriptor,
} from "@opensteer/protocol";

import { normalizeThrownOpensteerError } from "../internal/errors.js";
import {
  createOpensteerEngineFactory,
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import { OpensteerSessionRuntime } from "../sdk/runtime.js";
import { dispatchSemanticOperation } from "./dispatch.js";

export async function runOpensteerMcpServer(options: {
  readonly name: string;
  readonly rootDir?: string;
  readonly engine?: OpensteerEngineName;
}): Promise<void> {
  const runtime = new OpensteerSessionRuntime({
    name: options.name,
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    engineFactory: createOpensteerEngineFactory(options.engine ?? DEFAULT_OPENSTEER_ENGINE),
  });
  const toolByName = new Map(opensteerMcpTools.map((tool) => [tool.name, tool] as const));
  const server = new Server(
    {
      name: "opensteer",
      version: OPENSTEER_PROTOCOL_VERSION,
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    },
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await runtime.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opensteerMcpTools.map(toSdkTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolByName.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Unknown Opensteer tool "${request.params.name}".`,
          },
        ],
      } satisfies CallToolResult;
    }

    try {
      const input = request.params.arguments ?? {};
      assertValidSemanticOperationInput(tool.operation, input);
      const output = await dispatchSemanticOperation(runtime, tool.operation, input);
      return createToolResult(tool, output);
    } catch (error) {
      const normalized = normalizeThrownOpensteerError(
        error,
        `Opensteer ${tool.operation} failed.`,
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: normalized.message,
          },
        ],
      } satisfies CallToolResult;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toSdkTool(tool: OpensteerMcpToolDescriptor): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    outputSchema: tool.outputSchema as Tool["outputSchema"],
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  };
}

function createToolResult(tool: OpensteerMcpToolDescriptor, output: unknown): CallToolResult {
  if (tool.operation === "computer.execute") {
    const computerOutput = output as OpensteerComputerExecuteOutput;
    return {
      structuredContent: output as Record<string, unknown>,
      content: [
        toImageContent(computerOutput),
        {
          type: "text",
          text: `Opensteer computer.execute completed (${computerOutput.action.type}).`,
        },
      ],
    };
  }

  return {
    structuredContent: output as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: `Opensteer ${tool.operation} completed.`,
      },
    ],
  };
}

function toImageContent(output: OpensteerComputerExecuteOutput): ImageContent {
  return {
    type: "image",
    data: output.screenshot.payload.data,
    mimeType: output.screenshot.payload.mimeType ?? `image/${output.screenshot.format}`,
  };
}
