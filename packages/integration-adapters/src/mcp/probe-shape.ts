// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/mcp/src/sdk/probe-shape.ts (MIT).
import { asRecord } from "../shared.js";

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "opensteer-probe", version: "0" },
  },
};

export type McpShapeProbeResult =
  | {
      readonly kind: "mcp";
      readonly requiresAuth: boolean;
      readonly transport: "streamable-http";
    }
  | {
      readonly category: "auth-required" | "wrong-shape";
      readonly kind: "not-mcp";
      readonly reason: string;
    }
  | { readonly kind: "unreachable"; readonly reason: string };

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function jsonRpc(text: string): boolean {
  const object = jsonObject(text);
  return (
    object?.jsonrpc === "2.0" && ("result" in object || "error" in object || "method" in object)
  );
}

function oauthError(text: string): boolean {
  const object = jsonObject(text);
  return typeof object?.error === "string" && !Array.isArray(object.errors);
}

function resourceMatchesEndpoint(resource: string, endpoint: URL): boolean {
  if (!URL.canParse(resource)) return false;
  const parsed = new URL(resource);
  const resourcePath = parsed.pathname.replace(/\/+$/u, "");
  const endpointPath = endpoint.pathname.replace(/\/+$/u, "");
  return (
    parsed.origin === endpoint.origin &&
    (resourcePath === endpointPath || endpointPath.startsWith(`${resourcePath}/`))
  );
}

async function hasProtectedResourceMetadata(
  endpoint: URL,
  fetch_: typeof globalThis.fetch,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<boolean> {
  const path = endpoint.pathname === "/" ? "" : endpoint.pathname;
  const urls = [
    `${endpoint.origin}/.well-known/oauth-protected-resource${path}`,
    `${endpoint.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const url of new Set(urls)) {
    try {
      const response = await fetch_(url, {
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const metadata = asRecord((await response.json()) as unknown);
      if (
        typeof metadata?.resource === "string" &&
        Array.isArray(metadata.authorization_servers) &&
        metadata.authorization_servers.length > 0 &&
        resourceMatchesEndpoint(metadata.resource, endpoint)
      ) {
        return true;
      }
    } catch {
      // A metadata fallback is only an additional positive signal.
    }
  }
  return false;
}

async function classify(
  response: Response,
  metadataSignal: () => Promise<boolean>,
): Promise<McpShapeProbeResult | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  const eventStream = /^\s*text\/event-stream\b/iu.test(contentType);
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    const body = await response.text();
    if (!/^\s*bearer\b/iu.test(challenge)) {
      if (await metadataSignal()) {
        return {
          kind: "mcp",
          requiresAuth: true,
          transport: "streamable-http",
        };
      }
      return {
        kind: "not-mcp",
        category: "auth-required",
        reason: "401 without a Bearer challenge",
      };
    }
    if (
      /(?:^|[\s,])(?:resource_metadata|error)\s*=/iu.test(challenge) ||
      eventStream ||
      jsonRpc(body) ||
      oauthError(body)
    ) {
      return {
        kind: "mcp",
        requiresAuth: true,
        transport: "streamable-http",
      };
    }
    if (await metadataSignal()) {
      return {
        kind: "mcp",
        requiresAuth: true,
        transport: "streamable-http",
      };
    }
    return {
      kind: "not-mcp",
      category: "auth-required",
      reason: "Bearer challenge did not carry an MCP-compatible response shape",
    };
  }
  if (response.ok) {
    if (eventStream || jsonRpc(await response.text())) {
      return { kind: "mcp", requiresAuth: false, transport: "streamable-http" };
    }
    return {
      kind: "not-mcp",
      category: "wrong-shape",
      reason: "POST response is not JSON-RPC or SSE",
    };
  }
  return undefined;
}

export async function probeMcpEndpointShape(
  endpoint: string,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  } = {},
): Promise<McpShapeProbeResult> {
  const fetch_ = options.fetch ?? globalThis.fetch;
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(name, value);
  try {
    const metadataSignal = () =>
      hasProtectedResourceMetadata(url, fetch_, options.headers ?? {}, options.timeoutMs ?? 8_000);
    const post = await fetch_(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(INITIALIZE_BODY),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    const postResult = await classify(post, metadataSignal);
    if (postResult) return postResult;
    return {
      kind: "not-mcp",
      category: "wrong-shape",
      reason: `unexpected initialize status ${post.status}`,
    };
  } catch (cause) {
    return { kind: "unreachable", reason: cause instanceof Error ? cause.message : "fetch failed" };
  }
}
