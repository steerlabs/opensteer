// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/graphql/src/sdk/introspect.ts (MIT).
import { z } from "zod";
import { asRecord } from "../shared.js";

const GRAPHQL_INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: false) {
        name description
        args { name description defaultValue type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name description defaultValue type { ...TypeRef } }
      enumValues(includeDeprecated: false) { name description }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
}`;

export interface IntrospectionTypeRef {
  readonly kind: string;
  readonly name: string | null;
  readonly ofType?: IntrospectionTypeRef | null | undefined;
}

export interface IntrospectionInputValue {
  readonly defaultValue: string | null;
  readonly description: string | null;
  readonly name: string;
  readonly type: IntrospectionTypeRef;
}

export interface IntrospectionField {
  readonly args: readonly IntrospectionInputValue[];
  readonly description: string | null;
  readonly name: string;
  readonly type: IntrospectionTypeRef;
}

export interface IntrospectionType {
  readonly description: string | null;
  readonly enumValues:
    readonly { readonly description: string | null; readonly name: string }[] | null;
  readonly fields: readonly IntrospectionField[] | null;
  readonly inputFields: readonly IntrospectionInputValue[] | null;
  readonly kind: string;
  readonly name: string;
}

export interface IntrospectionResult {
  readonly __schema: {
    readonly mutationType: { readonly name: string } | null;
    readonly queryType: { readonly name: string } | null;
    readonly types: readonly IntrospectionType[];
  };
}

const TypeRefSchema: z.ZodType<IntrospectionTypeRef> = z.lazy(() =>
  z.looseObject({
    kind: z.string(),
    name: z.string().nullable(),
    ofType: TypeRefSchema.nullable().optional(),
  }),
);
const InputValueSchema = z.looseObject({
  defaultValue: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  name: z.string(),
  type: TypeRefSchema,
});
const FieldSchema = z.looseObject({
  args: z.array(InputValueSchema).default([]),
  description: z.string().nullable().default(null),
  name: z.string(),
  type: TypeRefSchema,
});
const TypeSchema = z.looseObject({
  description: z.string().nullable().default(null),
  enumValues: z
    .array(z.looseObject({ description: z.string().nullable().default(null), name: z.string() }))
    .nullable()
    .default(null),
  fields: z.array(FieldSchema).nullable().default(null),
  inputFields: z.array(InputValueSchema).nullable().default(null),
  kind: z.string(),
  name: z.string(),
});
const IntrospectionResultSchema: z.ZodType<IntrospectionResult> = z.looseObject({
  __schema: z.looseObject({
    mutationType: z.looseObject({ name: z.string() }).nullable().default(null),
    queryType: z.looseObject({ name: z.string() }).nullable().default(null),
    types: z.array(TypeSchema),
  }),
});

export function parseIntrospection(value: unknown): IntrospectionResult {
  const record = asRecord(value);
  return IntrospectionResultSchema.parse(record?.data ?? value);
}

export async function introspectGraphql(
  endpoint: string,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  } = {},
): Promise<IntrospectionResult> {
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(name, value);
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`GraphQL introspection returned HTTP ${response.status}`);
  const payload = (await response.json()) as unknown;
  const record = asRecord(payload);
  if (Array.isArray(record?.errors) && record.errors.length) {
    throw new Error("GraphQL introspection returned errors");
  }
  return parseIntrospection(payload);
}
