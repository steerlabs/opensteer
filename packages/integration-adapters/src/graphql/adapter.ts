// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/graphql/src/sdk/invoke.ts and plugin.ts (MIT).
import {
  renderAuthPlacements,
  type AdapterHealthResult,
  type AdapterToolResult,
  type IntegrationAdapter,
} from "@opensteer/integration-core";
import {
  decodeResponseBody,
  errorResult,
  isAbortError,
  MAX_RESPONSE_BYTES,
  stringAtPath,
} from "../shared.js";
import { GraphqlAdapterConfigSchema, type GraphqlAdapterConfig } from "./config.js";
import {
  extractGraphqlTools,
  findGraphqlOperation,
  graphqlOperationText,
  pruneGraphqlIntrospection,
  type GraphqlOperation,
} from "./extract.js";
import {
  introspectGraphql,
  parseIntrospection,
  type IntrospectionResult,
} from "./introspection.js";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";

async function schemaFor(
  config: GraphqlAdapterConfig,
  fetch_: typeof globalThis.fetch,
): Promise<IntrospectionResult> {
  return config.introspection
    ? parseIntrospection(config.introspection)
    : introspectGraphql(config.endpoint, { fetch: fetch_, timeoutMs: config.timeoutMs });
}

/**
 * Why `select` would leave the root field's selection set, if it would. It is
 * scanned as GraphQL lexes it, so a brace inside a string, block string or
 * comment does not count and every brace the endpoint counts does: a select
 * that never closes more braces than it opened cannot reach another root field
 * or start another operation.
 */
function selectionProblem(select: string): string | undefined {
  const unterminated = "select has an unterminated string; close every string it opens";
  let depth = 0;
  let index = 0;
  while (index < select.length) {
    const character = select[index];
    if (character === "#") {
      while (index < select.length && select[index] !== "\n" && select[index] !== "\r") index++;
    } else if (select.startsWith('"""', index)) {
      index += 3;
      while (!select.startsWith('"""', index)) {
        if (index >= select.length) return unterminated;
        index += select.startsWith('\\"""', index) ? 4 : 1;
      }
      index += 3;
    } else if (character === '"') {
      index += 1;
      while (select[index] !== '"') {
        const next = select[index] === "\\" ? select[index + 1] : select[index];
        if (next === undefined || next === "\n" || next === "\r") return unterminated;
        index += select[index] === "\\" ? 2 : 1;
      }
      index += 1;
    } else {
      if (character === "{") depth += 1;
      if (character === "}" && --depth < 0) {
        return "select closes a brace it did not open; it may only name fields of the result";
      }
      index += 1;
    }
  }
  return depth === 0 ? undefined : "select leaves a brace open; close every brace it opens";
}

// The endpoint validates argument values. These checks keep a call inside the
// root field its tool names.
function argumentsProblem(
  toolName: string,
  operation: GraphqlOperation,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const accepted = [...new Set([...operation.field.args.map(({ name }) => name), "select"])];
  const unknown = Object.keys(args).filter((name) => !accepted.includes(name));
  if (unknown.length) {
    const named = unknown.map((name) => JSON.stringify(name)).join(", ");
    return `${toolName} does not take ${named}; its arguments are ${accepted.join(", ")}`;
  }
  if (ownSelect(operation) || args.select === undefined) return undefined;
  if (typeof args.select !== "string") {
    return 'select must be text naming the fields to return, such as "id name"';
  }
  return selectionProblem(args.select);
}

/** A field with an argument named `select` takes it as a variable, not a selection. */
function ownSelect(operation: GraphqlOperation): boolean {
  return operation.field.args.some(({ name }) => name === "select");
}

async function executeGraphql(input: {
  readonly config: GraphqlAdapterConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: string;
  readonly queryParams: Readonly<Record<string, string>>;
  readonly variables?: Readonly<Record<string, unknown>>;
}): Promise<{ response: Response; value: unknown }> {
  const url = new URL(input.config.endpoint);
  for (const [name, value] of Object.entries(input.queryParams)) url.searchParams.set(name, value);
  const response = await input.fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...input.headers },
    body: JSON.stringify({
      query: input.query,
      ...(input.variables ? { variables: input.variables } : {}),
    }),
    signal: AbortSignal.timeout(input.config.timeoutMs),
  });
  const bytes = await readBoundedResponse(response, {
    maximumBytes: MAX_RESPONSE_BYTES,
    sizeError: () =>
      new RangeError(`Upstream response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`),
  });
  return { response, value: decodeResponseBody(response, bytes) };
}

export function createGraphqlAdapter(
  fetch_: typeof globalThis.fetch = globalThis.fetch,
): IntegrationAdapter {
  return {
    kind: "graphql",
    parseConfig(config: unknown): GraphqlAdapterConfig {
      return GraphqlAdapterConfigSchema.parse(config);
    },
    credentialDisclosure(config: unknown) {
      const parsed = GraphqlAdapterConfigSchema.parse(config);
      return {
        check: true,
        destinations: [new URL(parsed.endpoint).origin],
      };
    },
    async snapshotConfig(config: unknown) {
      const parsed = GraphqlAdapterConfigSchema.parse(config);
      const introspection = await schemaFor(parsed, fetch_);
      return GraphqlAdapterConfigSchema.parse({
        ...parsed,
        introspection: pruneGraphqlIntrospection(introspection, parsed),
      });
    },
    async resolveTools(input) {
      const config = GraphqlAdapterConfigSchema.parse(input.config);
      return extractGraphqlTools(await schemaFor(config, fetch_), config);
    },
    async invokeTool(input): Promise<AdapterToolResult> {
      const config = GraphqlAdapterConfigSchema.parse(input.config);
      let introspection: IntrospectionResult;
      try {
        introspection = await schemaFor(config, fetch_);
      } catch (cause) {
        return errorResult(
          "upstream_http_error",
          cause instanceof Error ? cause.message : "GraphQL schema resolution failed",
        );
      }
      const operation = findGraphqlOperation(introspection, config, input.toolName);
      if (!operation)
        return errorResult("invalid_arguments", `Unknown GraphQL tool "${input.toolName}"`);
      const problem = argumentsProblem(input.toolName, operation, input.args);
      if (problem) return errorResult("invalid_arguments", problem);
      let rendered: ReturnType<typeof renderAuthPlacements>;
      try {
        rendered = renderAuthPlacements(input.placements, input.credentialValues);
      } catch (cause) {
        return errorResult(
          "connection_rejected",
          cause instanceof Error ? cause.message : "Credential rendering failed",
        );
      }
      const variables = Object.fromEntries(
        operation.field.args.flatMap(({ name }) =>
          input.args[name] === undefined ? [] : [[name, input.args[name]]],
        ),
      );
      try {
        const { response, value } = await executeGraphql({
          config,
          fetch: fetch_,
          headers: rendered.headers,
          queryParams: rendered.query,
          query: graphqlOperationText(
            operation,
            introspection,
            !ownSelect(operation) && typeof input.args.select === "string"
              ? input.args.select
              : undefined,
          ),
          variables,
        });
        if (response.status === 401)
          return errorResult(
            "connection_rejected",
            "The GraphQL endpoint rejected the connection",
            {
              status: 401,
            },
          );
        if (
          response.status === 403 &&
          /insufficient_scope/iu.test(response.headers.get("www-authenticate") ?? "")
        ) {
          return errorResult("oauth_scope_insufficient", "The OAuth grant lacks a required scope", {
            status: 403,
          });
        }
        if (!response.ok)
          return errorResult(
            "upstream_http_error",
            `GraphQL endpoint returned HTTP ${response.status}`,
            { status: response.status, body: value },
          );
        const record =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : undefined;
        if (Array.isArray(record?.errors) && record.errors.length)
          return errorResult("upstream_http_error", "GraphQL returned operation errors", {
            errors: record.errors,
          });
        return { kind: "ok", value: record?.data ?? value };
      } catch (cause) {
        if (isAbortError(cause))
          return errorResult("upstream_timeout", "The GraphQL request timed out", {
            outcomeUnknown: true,
          });
        return errorResult(
          "upstream_http_error",
          cause instanceof Error ? cause.message : "GraphQL request failed",
          { outcomeUnknown: true },
        );
      }
    },
    async checkHealth(input): Promise<AdapterHealthResult> {
      const config = GraphqlAdapterConfigSchema.parse(input.config);
      let rendered: ReturnType<typeof renderAuthPlacements>;
      try {
        rendered = renderAuthPlacements(input.placements, input.credentialValues);
        if (!config.healthCheck) {
          await introspectGraphql(config.endpoint, {
            fetch: fetch_,
            headers: rendered.headers,
            query: rendered.query,
            timeoutMs: config.timeoutMs,
          });
          return { healthy: true };
        }
        const { response, value } = await executeGraphql({
          config,
          fetch: fetch_,
          headers: rendered.headers,
          queryParams: rendered.query,
          query: config.healthCheck.query,
          ...(config.healthCheck.variables ? { variables: config.healthCheck.variables } : {}),
        });
        if (!response.ok)
          return {
            healthy: false,
            detail: `GraphQL health check returned HTTP ${response.status}`,
          };
        const externalIdentityId = stringAtPath(value, config.healthCheck.identityPath);
        const accountIdentifier = stringAtPath(value, config.healthCheck.accountIdentifierPath);
        const displayName = stringAtPath(value, config.healthCheck.displayNamePath);
        const externalTenantId = stringAtPath(value, config.healthCheck.tenantPath);
        return {
          healthy: true,
          ...(externalIdentityId
            ? {
                identity: {
                  ...(accountIdentifier ? { accountIdentifier } : {}),
                  externalIdentityId,
                  ...(displayName ? { displayName } : {}),
                  ...(externalTenantId ? { externalTenantId } : {}),
                },
              }
            : {}),
        };
      } catch (cause) {
        return {
          healthy: false,
          detail: cause instanceof Error ? cause.message : "GraphQL health check failed",
        };
      }
    },
  };
}

export const graphqlAdapter = createGraphqlAdapter((target, init) =>
  globalThis.fetch(target, init),
);
