// Derived from github.com/UsefulSoftwareCo/executor packages/core/sdk/src/oauth-discovery.ts (MIT).
import { z } from "zod";
import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  assertSupportedOAuthEndpointUrl,
  type OAuthEndpointUrlPolicy,
} from "./oauth.js";

export class OAuthDiscoveryError extends Error {
  override readonly cause: unknown | undefined;
  readonly error: string | undefined;
  readonly errorDescription: string | undefined;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { cause?: unknown; error?: string; errorDescription?: string; status?: number } = {},
  ) {
    super(message);
    this.name = "OAuthDiscoveryError";
    this.cause = options.cause;
    this.error = options.error;
    this.errorDescription = options.errorDescription;
    this.status = options.status;
  }
}

const StringArraySchema = z.array(z.string());

export const OAuthProtectedResourceMetadataSchema = z.looseObject({
  authorization_servers: StringArraySchema.optional(),
  bearer_methods_supported: StringArraySchema.optional(),
  resource: z.string().optional(),
  resource_documentation: z.string().optional(),
  scopes_supported: StringArraySchema.optional(),
});
type OAuthProtectedResourceMetadata = z.infer<typeof OAuthProtectedResourceMetadataSchema>;

export const OAuthAuthorizationServerMetadataSchema = z.looseObject({
  authorization_endpoint: z.string(),
  client_id_metadata_document_supported: z.boolean().optional(),
  code_challenge_methods_supported: StringArraySchema.optional(),
  grant_types_supported: StringArraySchema.optional(),
  introspection_endpoint: z.string().optional(),
  issuer: z.string(),
  registration_endpoint: z.string().optional(),
  response_types_supported: StringArraySchema.optional(),
  revocation_endpoint: z.string().optional(),
  scopes_supported: StringArraySchema.optional(),
  token_endpoint: z.string(),
  token_endpoint_auth_methods_supported: StringArraySchema.optional(),
  userinfo_endpoint: z.string().optional(),
});
export type OAuthAuthorizationServerMetadata = z.infer<
  typeof OAuthAuthorizationServerMetadataSchema
>;

export const OAuthClientInformationSchema = z.looseObject({
  client_id: z.string(),
  client_id_issued_at: z.number().optional(),
  client_name: z.string().optional(),
  client_secret: z.string().optional(),
  client_secret_expires_at: z.number().optional(),
  grant_types: StringArraySchema.optional(),
  redirect_uris: StringArraySchema.optional(),
  registration_access_token: z.string().optional(),
  registration_client_uri: z.string().optional(),
  response_types: StringArraySchema.optional(),
  scope: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
});
type OAuthClientInformation = z.infer<typeof OAuthClientInformationSchema>;

export interface DynamicClientMetadata {
  readonly application_type?: "native" | "web";
  readonly client_name?: string;
  readonly client_uri?: string;
  readonly contacts?: readonly string[];
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly grant_types?: readonly string[];
  readonly logo_uri?: string;
  readonly redirect_uris: readonly string[];
  readonly response_types?: readonly string[];
  readonly scope?: string;
  readonly software_id?: string;
  readonly software_version?: string;
  readonly token_endpoint_auth_method?:
    "client_secret_basic" | "client_secret_post" | "none" | "private_key_jwt";
}

export interface DiscoveryRequestOptions {
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
  readonly mcpProtocolVersion?: string;
  readonly resourceHeaders?: Readonly<Record<string, string>>;
  readonly resourceQueryParams?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

async function fetchText(
  url: string,
  init: RequestInit,
  options: DiscoveryRequestOptions,
): Promise<{ body: string; status: number }> {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  } catch (cause) {
    throw new OAuthDiscoveryError(`OAuth discovery request failed for ${url}`, { cause });
  }
}

function resourceMetadataUrls(resourceUrl: string, policy: OAuthEndpointUrlPolicy = {}): string[] {
  const url = new URL(
    assertSupportedOAuthEndpointUrl(resourceUrl, "Protected resource URL", policy),
  );
  const path = url.pathname.replace(/\/+$/, "");
  return [
    ...(path && path !== "/" ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
}

export async function discoverProtectedResourceMetadata(
  resourceUrl: string,
  options: DiscoveryRequestOptions = {},
): Promise<{
  readonly metadata: OAuthProtectedResourceMetadata;
  readonly metadataUrl: string;
} | null> {
  for (const metadataUrl of resourceMetadataUrls(resourceUrl, options.endpointUrlPolicy)) {
    const url = new URL(metadataUrl);
    for (const [name, value] of Object.entries(options.resourceQueryParams ?? {})) {
      url.searchParams.set(name, value);
    }
    const headers = new Headers({ accept: "application/json" });
    for (const [name, value] of Object.entries(options.resourceHeaders ?? {})) {
      headers.set(name, value);
    }
    if (options.mcpProtocolVersion) {
      headers.set("mcp-protocol-version", options.mcpProtocolVersion);
    }
    const response = await fetchText(url.toString(), { headers }, options);
    if ([404, 405].includes(response.status) || response.body.length === 0) continue;
    if (response.status < 200 || response.status >= 300) {
      throw new OAuthDiscoveryError(
        `Protected resource metadata returned status ${response.status}`,
        { status: response.status },
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.body) as unknown;
    } catch (cause) {
      throw new OAuthDiscoveryError("Protected resource metadata is malformed", { cause });
    }
    const parsed = OAuthProtectedResourceMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      throw new OAuthDiscoveryError("Protected resource metadata is malformed", {
        cause: parsed.error,
      });
    }
    return { metadataUrl, metadata: parsed.data };
  }
  return null;
}

function wellKnownUrl(issuer: URL, kind: "oauth2" | "oidc"): string {
  const suffix = kind === "oauth2" ? "oauth-authorization-server" : "openid-configuration";
  const path = issuer.pathname.replace(/\/+$/, "");
  return path && path !== "/"
    ? `${issuer.origin}/.well-known/${suffix}${path}`
    : `${issuer.origin}/.well-known/${suffix}`;
}

function validateAuthorizationServerMetadata(
  metadata: OAuthAuthorizationServerMetadata,
  policy: OAuthEndpointUrlPolicy = {},
): void {
  assertSupportedOAuthEndpointUrl(metadata.issuer, "issuer", policy);
  assertSupportedOAuthEndpointUrl(
    metadata.authorization_endpoint,
    "authorization_endpoint",
    policy,
  );
  assertSupportedOAuthEndpointUrl(metadata.token_endpoint, "token_endpoint", policy);
  if (metadata.registration_endpoint) {
    assertSupportedOAuthEndpointUrl(
      metadata.registration_endpoint,
      "registration_endpoint",
      policy,
    );
  }
}

export async function discoverAuthorizationServerMetadata(
  issuer: string,
  options: DiscoveryRequestOptions = {},
): Promise<{
  readonly metadata: OAuthAuthorizationServerMetadata;
  readonly metadataUrl: string;
} | null> {
  const issuerUrl = new URL(
    assertSupportedOAuthEndpointUrl(issuer, "issuer", options.endpointUrlPolicy),
  );
  for (const kind of ["oauth2", "oidc"] as const) {
    const metadataUrl = wellKnownUrl(issuerUrl, kind);
    let response: { body: string; status: number };
    try {
      response = await fetchText(
        metadataUrl,
        {
          headers: {
            accept: "application/json",
            ...(options.mcpProtocolVersion
              ? { "mcp-protocol-version": options.mcpProtocolVersion }
              : {}),
          },
        },
        options,
      );
    } catch {
      continue;
    }
    if (response.status < 200 || response.status >= 300) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(response.body) as unknown;
    } catch {
      continue;
    }
    const parsed = OAuthAuthorizationServerMetadataSchema.safeParse(raw);
    if (!parsed.success) continue;
    try {
      validateAuthorizationServerMetadata(parsed.data, options.endpointUrlPolicy);
    } catch {
      continue;
    }
    return { metadataUrl, metadata: parsed.data };
  }
  return null;
}

interface RegisterDynamicClientInput {
  readonly initialAccessToken?: string | null;
  readonly metadata: DynamicClientMetadata;
  readonly registrationEndpoint: string;
}

function dynamicClientBody(metadata: DynamicClientMetadata): Record<string, unknown> {
  const { extra, ...standard } = metadata;
  return {
    ...standard,
    redirect_uris: [...metadata.redirect_uris],
    ...(metadata.grant_types ? { grant_types: [...metadata.grant_types] } : {}),
    ...(metadata.response_types ? { response_types: [...metadata.response_types] } : {}),
    ...(metadata.contacts ? { contacts: [...metadata.contacts] } : {}),
    ...extra,
  };
}

export async function registerDynamicClient(
  input: RegisterDynamicClientInput,
  options: DiscoveryRequestOptions = {},
): Promise<OAuthClientInformation> {
  const endpoint = assertSupportedOAuthEndpointUrl(
    input.registrationEndpoint,
    "registration_endpoint",
    options.endpointUrlPolicy,
  );
  const response = await fetchText(
    endpoint,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(input.initialAccessToken
          ? { authorization: `Bearer ${input.initialAccessToken}` }
          : {}),
      },
      body: JSON.stringify(dynamicClientBody(input.metadata)),
    },
    options,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(response.body) as unknown;
  } catch (cause) {
    throw new OAuthDiscoveryError("Dynamic Client Registration response is malformed", {
      cause,
      status: response.status,
    });
  }
  if (response.status !== 200 && response.status !== 201) {
    const error = z
      .looseObject({ error: z.string(), error_description: z.string().optional() })
      .safeParse(raw);
    throw new OAuthDiscoveryError(
      error.success
        ? `Dynamic Client Registration failed: ${error.data.error}${error.data.error_description ? ` — ${error.data.error_description}` : ""}`
        : `Dynamic Client Registration endpoint returned status ${response.status}`,
      {
        status: response.status,
        ...(error.success ? { error: error.data.error } : {}),
        ...(error.success && error.data.error_description
          ? { errorDescription: error.data.error_description }
          : {}),
      },
    );
  }
  const parsed = OAuthClientInformationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OAuthDiscoveryError("Dynamic Client Registration response is malformed", {
      cause: parsed.error,
      status: response.status,
    });
  }
  return parsed.data;
}
