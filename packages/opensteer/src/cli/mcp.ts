import { readFile } from "node:fs/promises";

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
  type OpensteerRawRequestOutput,
  assertValidSemanticOperationInput,
  opensteerMcpTools,
  type OpensteerMcpToolDescriptor,
} from "@opensteer/protocol";

import { normalizeThrownOpensteerError } from "../internal/errors.js";
import {
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import { fileUriToPath } from "../internal/filesystem.js";
import { createOpensteerSemanticRuntime } from "../sdk/runtime-resolution.js";
import { dispatchSemanticOperation } from "./dispatch.js";

export async function runOpensteerMcpServer(options: {
  readonly name: string;
  readonly rootDir?: string;
  readonly engine?: OpensteerEngineName;
  readonly cloud?: boolean;
}): Promise<void> {
  const runtime = createOpensteerSemanticRuntime({
    runtimeOptions: {
      name: options.name,
      ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    },
    engine: options.engine ?? DEFAULT_OPENSTEER_ENGINE,
    ...(options.cloud ? { cloud: true } : {}),
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
  const outputSchema = toSdkToolOutputSchema(tool.outputSchema);
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  };
}

function toSdkToolOutputSchema(
  schema: OpensteerMcpToolDescriptor["outputSchema"],
): Tool["outputSchema"] | undefined {
  return schema.type === "object" ? (schema as Tool["outputSchema"]) : undefined;
}

async function createToolResult(
  tool: OpensteerMcpToolDescriptor,
  output: unknown,
): Promise<CallToolResult> {
  if (tool.operation === "computer.execute") {
    const computerOutput = output as OpensteerComputerExecuteOutput;
    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [
        await toImageContent(computerOutput),
        {
          type: "text",
          text: `Opensteer computer.execute completed (${computerOutput.action.type}).`,
        },
      ],
    };
  }

  if (tool.operation === "request.raw") {
    return createRawRequestToolResult(output as OpensteerRawRequestOutput);
  }

  return {
    structuredContent: output as unknown as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: `Opensteer ${tool.operation} completed.`,
      },
    ],
  };
}

function createRawRequestToolResult(output: OpensteerRawRequestOutput): CallToolResult {
  const mimeType = inferResponseMimeType(output);
  const textContent = formatRawResponseText(output);

  if (mimeType?.startsWith("image/") && output.response.body !== undefined) {
    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [
        {
          type: "image",
          data: output.response.body.data,
          mimeType,
        },
      ],
    };
  }

  return {
    structuredContent: output as unknown as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: textContent,
      },
    ],
  };
}

function inferResponseMimeType(output: OpensteerRawRequestOutput): string | undefined {
  const header = output.response.headers.find(
    (entry) => entry.name.toLowerCase() === "content-type",
  )?.value;
  if (header) {
    return header.split(";")[0]?.trim().toLowerCase();
  }
  return output.response.body?.mimeType?.toLowerCase();
}

function formatRawResponseText(output: OpensteerRawRequestOutput): string {
  if (output.data !== undefined) {
    return typeof output.data === "string" ? output.data : JSON.stringify(output.data, null, 2);
  }
  if (output.response.body !== undefined) {
    return Buffer.from(output.response.body.data, "base64").toString("utf8");
  }
  return `Opensteer request.raw completed (${String(output.response.status)}).`;
}

async function toImageContent(output: OpensteerComputerExecuteOutput): Promise<ImageContent> {
  const data = await readFile(fileUriToPath(output.screenshot.payload.uri));
  return {
    type: "image",
    data: data.toString("base64"),
    mimeType: output.screenshot.payload.mimeType,
  };
}
