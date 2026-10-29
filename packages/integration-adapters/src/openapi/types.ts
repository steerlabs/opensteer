// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/types.ts (MIT).
export type HttpMethod = "delete" | "get" | "head" | "options" | "patch" | "post" | "put" | "trace";

export interface OpenApiParameter {
  readonly allowReserved?: boolean;
  readonly description?: string;
  readonly explode?: boolean;
  readonly location: "cookie" | "header" | "path" | "query";
  readonly name: string;
  readonly required: boolean;
  /** As the document writes it; only discovery turns it into a tool schema. */
  readonly schema: unknown;
  readonly style?: string;
}

export interface OpenApiMediaBinding {
  readonly contentType: string;
  readonly encoding?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** As the document writes it; only discovery turns it into a tool schema. */
  readonly schema: unknown;
}

/** One admitted operation, bound as far as sending a request needs. */
export interface OpenApiOperation {
  readonly method: HttpMethod;
  readonly name: string;
  readonly operationId: string;
  readonly parameters: readonly OpenApiParameter[];
  readonly path: string;
  readonly requestBody?: {
    readonly contents: readonly OpenApiMediaBinding[];
    readonly required: boolean;
  };
  readonly servers: readonly string[];
}
