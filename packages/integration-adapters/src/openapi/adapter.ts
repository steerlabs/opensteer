// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/plugin.ts (MIT).
import type {
  AdapterHealthResult,
  ApiKeyDisclosure,
  AdapterToolResult,
  IntegrationAdapter,
} from "@opensteer/integration-core";
import { stringAtPath } from "../shared.js";
import {
  OpenApiAdapterConfigSchema,
  OpenApiToolTargetSchema,
  type OpenApiAdapterConfig,
} from "./config.js";
import {
  extractOpenApiTools,
  findOpenApiOperation,
  openApiOperations,
  pruneOpenApiDocument,
} from "./extract.js";
import { invokeOpenApiOperation, openApiOperationServer } from "./invoke.js";
import { resolveOpenApiDocument, type OpenApiDocument } from "./parse.js";
import type { OpenApiOperation } from "./types.js";

async function operationFor(
  config: OpenApiAdapterConfig,
  fetch_: typeof globalThis.fetch,
  matches: Parameters<typeof findOpenApiOperation>[2],
): Promise<OpenApiOperation | undefined> {
  return findOpenApiOperation(await resolveOpenApiDocument(config, fetch_), config, matches);
}

/** Computed from the resolved document at inspection/snapshot time, using invocation routing. */
export function openApiCredentialDisclosure(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
): ApiKeyDisclosure {
  return {
    check: config.healthCheck !== undefined,
    destinations: [
      ...new Set(
        openApiOperations(document, config).map(
          (operation) => new URL(openApiOperationServer(config, operation)).origin,
        ),
      ),
    ].sort(),
  };
}

export function createOpenApiAdapter(
  fetch_: typeof globalThis.fetch = globalThis.fetch,
): IntegrationAdapter {
  return {
    kind: "openapi",
    parseConfig(config: unknown): OpenApiAdapterConfig {
      return OpenApiAdapterConfigSchema.parse(config);
    },
    credentialDisclosure(config: unknown) {
      const parsed = OpenApiAdapterConfigSchema.parse(config);
      return parsed.credentialDestinations
        ? { check: parsed.healthCheck !== undefined, destinations: parsed.credentialDestinations }
        : null;
    },
    async snapshotConfig(config: unknown) {
      const parsed = OpenApiAdapterConfigSchema.parse(config);
      const document = pruneOpenApiDocument(await resolveOpenApiDocument(parsed, fetch_), parsed);
      // The document is stored with its overrides applied; keeping them would apply them twice.
      const { googleDiscovery, inline, specOverrides, specUrl, ...runtime } = parsed;
      void googleDiscovery;
      void inline;
      void specOverrides;
      void specUrl;
      return OpenApiAdapterConfigSchema.parse({
        ...runtime,
        inline: document,
        credentialDestinations: openApiCredentialDisclosure(document, parsed).destinations,
      });
    },
    async resolveTools(input) {
      const config = OpenApiAdapterConfigSchema.parse(input.config);
      return extractOpenApiTools(await resolveOpenApiDocument(config, fetch_), config);
    },
    async invokeTool(input): Promise<AdapterToolResult> {
      const config = OpenApiAdapterConfigSchema.parse(input.config);
      const target = OpenApiToolTargetSchema.safeParse(input.target);
      if (!target.success) {
        return {
          kind: "error",
          code: "invalid_arguments",
          message: `OpenAPI tool "${input.toolName}" names no operation`,
        };
      }
      let operation: OpenApiOperation | undefined;
      try {
        operation = await operationFor(
          config,
          fetch_,
          ({ method, path }) => method === target.data.method && path === target.data.path,
        );
      } catch (cause) {
        return {
          kind: "error",
          code: "upstream_http_error",
          message: cause instanceof Error ? cause.message : "Failed to resolve OpenAPI document",
        };
      }
      if (!operation) {
        return {
          kind: "error",
          code: "invalid_arguments",
          message: `OpenAPI tool "${input.toolName}" names no operation`,
        };
      }
      return invokeOpenApiOperation({ ...input, config, fetch: fetch_, operation });
    },
    async checkHealth(input): Promise<AdapterHealthResult> {
      const config = OpenApiAdapterConfigSchema.parse(input.config);
      const healthCheck = config.healthCheck;
      // A definition that names no check offers no
      // way to verify a key. Refusing it would make the integration impossible to
      // connect; a key the service rejects fails its first call instead, which
      // marks the connection for attention.
      if (!healthCheck) return { healthy: true };
      let operation: OpenApiOperation | undefined;
      try {
        operation = await operationFor(config, fetch_, (candidate) =>
          healthCheck.operationId
            ? candidate.operationId === healthCheck.operationId
            : candidate.method === healthCheck.method && candidate.path === healthCheck.path,
        );
      } catch (cause) {
        return {
          healthy: false,
          detail: cause instanceof Error ? cause.message : "Failed to resolve OpenAPI document",
        };
      }
      if (!operation)
        return { healthy: false, detail: "The configured health check operation was not found" };
      const result = await invokeOpenApiOperation({
        args: healthCheck.args ?? {},
        config,
        credentialValues: input.credentialValues,
        fetch: fetch_,
        operation,
        placements: input.placements,
      });
      if (result.kind === "error")
        return {
          healthy: false,
          detail: result.message,
          ...(typeof result.details?.status === "number" ? { status: result.details.status } : {}),
        };
      const accountIdentifier = stringAtPath(result.value, healthCheck.accountIdentifierPath);
      const externalIdentityId = stringAtPath(result.value, healthCheck.identityPath);
      const displayName = stringAtPath(result.value, healthCheck.displayNamePath);
      const externalTenantId = stringAtPath(result.value, healthCheck.tenantPath);
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
    },
  };
}

export const openApiAdapter = createOpenApiAdapter((target, init) =>
  globalThis.fetch(target, init),
);
