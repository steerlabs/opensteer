import type { JsonObject, JsonSchema } from "./json.js";
import { opensteerOperationSpecifications, type OpensteerOperationName } from "./operations.js";

export interface OpensteerMcpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface OpensteerMcpToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly operation: OpensteerOperationName;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly annotations?: OpensteerMcpToolAnnotations;
}

export interface OpensteerMcpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface OpensteerMcpToolResult<TStructured extends JsonObject = JsonObject> {
  readonly structuredContent: TStructured;
  readonly content?: readonly OpensteerMcpTextContent[];
  readonly isError?: boolean;
}

const readOnlyOperations = new Set<OpensteerOperationName>([
  "artifact.captureScreenshot",
  "inspect.listPages",
  "inspect.listFrames",
  "inspect.getPageInfo",
  "inspect.getFrameInfo",
  "inspect.getHtmlSnapshot",
  "inspect.getDomSnapshot",
  "inspect.readText",
  "inspect.readAttributes",
  "inspect.hitTest",
  "inspect.getViewportMetrics",
  "inspect.getNetworkRecords",
  "inspect.getCookies",
  "inspect.getStorageSnapshot",
]);

const destructiveOperations = new Set<OpensteerOperationName>(["session.close", "page.close"]);

function toolNameFromOperation(operation: OpensteerOperationName): string {
  return `opensteer_${operation.replaceAll(".", "_")}`;
}

function titleFromOperation(operation: OpensteerOperationName): string {
  return operation
    .split(".")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export const opensteerMcpTools: readonly OpensteerMcpToolDescriptor[] =
  opensteerOperationSpecifications.map((spec) => ({
    name: toolNameFromOperation(spec.name),
    title: titleFromOperation(spec.name),
    description: spec.description,
    operation: spec.name,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    annotations: {
      readOnlyHint: readOnlyOperations.has(spec.name),
      destructiveHint: destructiveOperations.has(spec.name),
      idempotentHint: readOnlyOperations.has(spec.name),
      openWorldHint: true,
    },
  }));

export function createStructuredToolResult<TStructured extends JsonObject>(
  structuredContent: TStructured,
  options: {
    readonly text?: string;
    readonly isError?: boolean;
  } = {},
): OpensteerMcpToolResult<TStructured> {
  return {
    structuredContent,
    ...(options.text === undefined
      ? {}
      : {
          content: [
            {
              type: "text",
              text: options.text,
            },
          ],
        }),
    ...(options.isError === undefined ? {} : { isError: options.isError }),
  };
}
