import type { JsonObject, JsonSchema } from "./json.js";
import {
  opensteerSemanticOperationSpecifications,
  type OpensteerSemanticOperationName,
} from "./semantic.js";

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
  readonly operation: OpensteerSemanticOperationName;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly annotations?: OpensteerMcpToolAnnotations;
}

export interface OpensteerMcpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface OpensteerMcpImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type OpensteerMcpContent = OpensteerMcpTextContent | OpensteerMcpImageContent;

export interface OpensteerMcpToolResult<TStructured extends JsonObject = JsonObject> {
  readonly structuredContent: TStructured;
  readonly content?: readonly OpensteerMcpContent[];
  readonly isError?: boolean;
}

const readOnlyOperations = new Set<OpensteerSemanticOperationName>([
  "page.snapshot",
  "dom.extract",
  "network.query",
  "request-plan.get",
  "request-plan.list",
]);

const destructiveOperations = new Set<OpensteerSemanticOperationName>([
  "network.clear",
  "session.close",
]);

function toolNameFromOperation(operation: OpensteerSemanticOperationName): string {
  return `opensteer_${operation.replaceAll(".", "_").replaceAll("-", "_")}`;
}

function titleFromOperation(operation: OpensteerSemanticOperationName): string {
  return operation
    .split(/[.-]/)
    .map((segment) => {
      switch (segment) {
        case "dom":
          return "DOM";
        case "html":
          return "HTML";
        default:
          return segment.charAt(0).toUpperCase() + segment.slice(1);
      }
    })
    .join(" ");
}

export const opensteerMcpTools: readonly OpensteerMcpToolDescriptor[] =
  opensteerSemanticOperationSpecifications.map((spec) => ({
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
    readonly content?: readonly OpensteerMcpContent[];
    readonly isError?: boolean;
  } = {},
): OpensteerMcpToolResult<TStructured> {
  const content =
    options.content ??
    (options.text === undefined
      ? undefined
      : [
          {
            type: "text",
            text: options.text,
          } satisfies OpensteerMcpTextContent,
        ]);

  return {
    structuredContent,
    ...(content === undefined ? {} : { content }),
    ...(options.isError === undefined ? {} : { isError: options.isError }),
  };
}
