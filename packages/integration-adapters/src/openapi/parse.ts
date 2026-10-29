// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/parse.ts (MIT).
import { parse as parseYaml } from "yaml";
import {
  bundleGoogleDiscoveryDocuments,
  googleDiscoveryUrl,
} from "../google-discovery/discovery.js";
import type { GoogleService } from "../google-discovery/discovery.js";
import type { OpenApiAdapterConfig } from "./config.js";
import { applySpecOverrides } from "./spec-overrides.js";
import { asRecord } from "../shared.js";

export type OpenApiDocument = Record<string, unknown>;

export function parseOpenApiDocument(text: string): OpenApiDocument {
  if (!text.trim()) throw new TypeError("OpenAPI document is empty");
  let parsed: unknown;
  try {
    parsed = text.trimStart().startsWith("{")
      ? (JSON.parse(text) as unknown)
      : (parseYaml(text) as unknown);
  } catch (cause) {
    throw new TypeError("Failed to parse OpenAPI document", { cause });
  }
  const document = asRecord(parsed);
  if (!document) throw new TypeError("OpenAPI document must parse to an object");
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) {
    throw new TypeError("Only OpenAPI 3.x documents are supported");
  }
  return document;
}

async function fetchDocument(
  url: string,
  fetch_: typeof globalThis.fetch,
): Promise<OpenApiDocument> {
  const response = await fetch_(url, {
    headers: { accept: "application/json, application/yaml, text/yaml, */*" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Failed to fetch OpenAPI document: HTTP ${response.status}`);
  return parseOpenApiDocument(await response.text());
}

export async function resolveOpenApiDocument(
  config: OpenApiAdapterConfig,
  fetch_: typeof globalThis.fetch = globalThis.fetch,
): Promise<OpenApiDocument> {
  let document: OpenApiDocument;
  if (config.googleDiscovery) {
    const documents = await Promise.all(
      config.googleDiscovery.services.map(async (serviceConfig) => {
        const { service, url, version } = serviceConfig;
        const response = await fetch_(url ?? googleDiscoveryUrl(service, version), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok)
          throw new Error(`Failed to fetch Google Discovery document: HTTP ${response.status}`);
        return {
          document: (await response.json()) as unknown,
          service: serviceConfig as unknown as GoogleService,
        };
      }),
    );
    document = bundleGoogleDiscoveryDocuments(documents);
  } else if (config.specUrl) {
    document = await fetchDocument(config.specUrl, fetch_);
  } else if (typeof config.inline === "string") {
    document = parseOpenApiDocument(config.inline);
  } else if (config.inline) {
    // Read-only from here on; applying overrides is the one change, and it copies first.
    document = config.inline;
  } else {
    throw new TypeError("OpenAPI config has no spec source");
  }
  return config.specOverrides?.length
    ? applySpecOverrides(document, config.specOverrides)
    : document;
}
