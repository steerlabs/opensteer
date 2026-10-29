// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/providers/google/discovery.ts (MIT).
import { asRecord } from "../shared.js";
import type { OpenApiAdapterConfig } from "../openapi/config.js";
import type { OpenApiDocument } from "../openapi/parse.js";

export interface GoogleService {
  readonly blockedMethodIds?: string[];
  readonly blockedMethodPrefixes?: string[];
  readonly blockedMethodSubstrings?: string[];
  readonly consentScopes?: string[];
  readonly hiddenParameters?: string[];
  readonly hiddenSchemaProperties?: Readonly<Record<string, string[]>>;
  readonly requiredParameters?: Readonly<Record<string, string[]>>;
  readonly requiredRequestBodies?: string[];
  readonly requiredSchemaProperties?: Readonly<Record<string, string[]>>;
  readonly service: string;
  readonly url?: string;
  readonly version: string;
}

const DEFAULT_VERSIONS: Readonly<Record<string, string>> = {
  calendar: "v3",
  drive: "v3",
  gmail: "v1",
  people: "v1",
};

export function googleDiscoveryUrl(service: string, version: string): string {
  return `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;
}

function compactGoogleOAuthScopes(scopes: Iterable<string>): string[] {
  const ordered = [...new Set([...scopes].map((scope) => scope.trim()).filter(Boolean))];
  const broad: readonly [string, readonly string[]][] = [
    ["https://mail.google.com/", ["https://www.googleapis.com/auth/gmail."]],
    ["https://www.googleapis.com/auth/calendar", ["https://www.googleapis.com/auth/calendar."]],
    ["https://www.googleapis.com/auth/drive", ["https://www.googleapis.com/auth/drive."]],
  ];
  return ordered.filter(
    (scope) =>
      !broad.some(
        ([parent, prefixes]) =>
          scope !== parent &&
          ordered.includes(parent) &&
          prefixes.some((prefix) => scope.startsWith(prefix)),
      ),
  );
}

function googleMethodAllowed(service: GoogleService | undefined, methodId: string): boolean {
  return (
    !service?.blockedMethodIds?.includes(methodId) &&
    !service?.blockedMethodPrefixes?.some((prefix) => methodId.startsWith(prefix)) &&
    !service?.blockedMethodSubstrings?.some((part) => methodId.includes(part))
  );
}

export function googleDiscoveryOpenApiConfig(
  serviceIds: readonly (GoogleService | string)[],
  options: Omit<OpenApiAdapterConfig, "googleDiscovery" | "inline" | "specUrl"> = {
    timeoutMs: 30_000,
  },
): OpenApiAdapterConfig {
  const services = serviceIds.map((service): GoogleService => {
    if (typeof service !== "string") return service;
    const [name, explicitVersion] = service.split(":", 2);
    if (!name) throw new TypeError("Google service id cannot be empty");
    const version = explicitVersion ?? DEFAULT_VERSIONS[name];
    if (!version) throw new TypeError(`Google service id "${name}" requires an explicit version`);
    return { service: name, version };
  });
  return {
    ...options,
    googleDiscovery: { services },
    timeoutMs: options.timeoutMs ?? 30_000,
  };
}

function googleSchema(
  value: unknown,
  prefix: string,
  serviceHint?: GoogleService,
  schemaName?: string,
): unknown {
  const schema = asRecord(value);
  if (!schema) return {};
  if (typeof schema.$ref === "string")
    return { $ref: `#/components/schemas/${prefix}${schema.$ref}` };
  const type = schema.repeated === true ? "array" : schema.type;
  if (type === "array") {
    return {
      type: "array",
      items: googleSchema(
        schema.items ?? { ...schema, repeated: false, type: schema.type },
        prefix,
        serviceHint,
      ),
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    };
  }
  const properties = asRecord(schema.properties);
  const hidden = new Set(serviceHint?.hiddenSchemaProperties?.[schemaName ?? ""] ?? []);
  const convertedProperties = properties
    ? Object.fromEntries(
        Object.entries(properties)
          .filter(([name]) => !hidden.has(name))
          .map(([name, property]) => [name, googleSchema(property, prefix, serviceHint)]),
      )
    : undefined;
  const required = properties
    ? Object.entries(properties).flatMap(([name, property]) =>
        !hidden.has(name) && asRecord(property)?.required === true ? [name] : [],
      )
    : [];
  const policyRequired = serviceHint?.requiredSchemaProperties?.[schemaName ?? ""] ?? [];
  return {
    ...(typeof type === "string" ? { type: type === "any" ? undefined : type } : {}),
    ...(typeof schema.format === "string" ? { format: schema.format } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
    ...(convertedProperties ? { properties: convertedProperties } : {}),
    ...(required.length || policyRequired.length
      ? { required: [...new Set([...required, ...policyRequired])] }
      : {}),
    ...(schema.additionalProperties !== undefined
      ? {
          additionalProperties:
            typeof schema.additionalProperties === "boolean"
              ? schema.additionalProperties
              : googleSchema(schema.additionalProperties, prefix, serviceHint),
        }
      : {}),
  };
}

function parameterObject(
  name: string,
  value: unknown,
  prefix: string,
  serviceHint?: GoogleService,
  methodId?: string,
): Record<string, unknown> | undefined {
  const parameter = asRecord(value);
  if (!parameter) return undefined;
  const location = parameter.location;
  if (
    !["header", "path", "query"].includes(String(location)) ||
    serviceHint?.hiddenParameters?.includes(name)
  )
    return undefined;
  const schema = googleSchema(parameter, prefix, serviceHint) as Record<string, unknown>;
  return {
    name,
    in: location,
    required:
      location === "path" ||
      parameter.required === true ||
      serviceHint?.requiredParameters?.[methodId ?? ""]?.includes(name) === true,
    schema,
    ...(typeof parameter.description === "string" ? { description: parameter.description } : {}),
    ...(parameter.repeated === true ? { style: "form", explode: true } : {}),
  };
}

function methodEntries(
  resources: Record<string, unknown>,
  parent: readonly string[] = [],
): readonly { method: Record<string, unknown>; resourcePath: readonly string[] }[] {
  const entries: { method: Record<string, unknown>; resourcePath: readonly string[] }[] = [];
  const methods = asRecord(resources.methods) ?? (parent.length === 0 ? resources : {});
  for (const method of Object.values(methods)) {
    const record = asRecord(method);
    if (record?.httpMethod && record.path) entries.push({ method: record, resourcePath: parent });
  }
  for (const [name, resource] of Object.entries(asRecord(resources.resources) ?? {})) {
    const record = asRecord(resource);
    if (record) entries.push(...methodEntries(record, [...parent, name]));
  }
  return entries;
}

export function convertGoogleDiscoveryDocument(
  document: unknown,
  serviceHint?: GoogleService,
): OpenApiDocument {
  const discovery = asRecord(document);
  if (!discovery) throw new TypeError("Google Discovery document must be an object");
  const service =
    (typeof discovery.name === "string" && discovery.name) || serviceHint?.service || "google";
  const version =
    (typeof discovery.version === "string" && discovery.version) || serviceHint?.version || "v1";
  const prefix = `${service}_`;
  const rootUrl =
    typeof discovery.rootUrl === "string" ? discovery.rootUrl : "https://www.googleapis.com/";
  const servicePath = typeof discovery.servicePath === "string" ? discovery.servicePath : "";
  const baseUrl = new URL(servicePath, rootUrl).toString();
  const schemas = Object.fromEntries(
    Object.entries(asRecord(discovery.schemas) ?? {}).map(([name, schema]) => [
      `${prefix}${name}`,
      googleSchema(schema, prefix, serviceHint, name),
    ]),
  );
  const globalParameters = asRecord(discovery.parameters) ?? {};
  const oauthScopes = asRecord(asRecord(asRecord(discovery.auth)?.oauth2)?.scopes) ?? {};
  const paths: Record<string, Record<string, unknown>> = {};
  const roots: Record<string, unknown> = {
    methods: asRecord(discovery.methods) ?? {},
    resources: asRecord(discovery.resources) ?? {},
  };
  for (const { method, resourcePath } of methodEntries(roots)) {
    const rawPath = String(method.path);
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const methodName = String(method.httpMethod).toLowerCase();
    const operationId =
      (typeof method.id === "string" && method.id) ||
      `${service}.${[...resourcePath, methodName].join(".")}`;
    if (!googleMethodAllowed(serviceHint, operationId)) continue;
    const parameters = {
      ...globalParameters,
      ...asRecord(method.parameters),
    };
    const parameterObjects = Object.entries(parameters).flatMap(([name, parameter]) => {
      const converted = parameterObject(name, parameter, prefix, serviceHint, operationId);
      return converted ? [converted] : [];
    });
    const request = asRecord(method.request);
    const response = asRecord(method.response);
    const scopes = Array.isArray(method.scopes)
      ? method.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const consentScopes = serviceHint?.consentScopes;
    const effectiveScopes = consentScopes
      ? compactGoogleOAuthScopes(scopes.filter((scope) => consentScopes.includes(scope)))
      : scopes;
    paths[path] ??= {};
    paths[path]![methodName] = {
      operationId,
      tags: [service, ...resourcePath],
      ...(typeof method.description === "string" ? { description: method.description } : {}),
      parameters: parameterObjects,
      servers: [{ url: baseUrl }],
      ...(typeof request?.$ref === "string"
        ? {
            requestBody: {
              required: serviceHint?.requiredRequestBodies?.includes(operationId) ?? true,
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${prefix}${request.$ref}` },
                },
              },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema:
                typeof response?.$ref === "string"
                  ? { $ref: `#/components/schemas/${prefix}${response.$ref}` }
                  : {},
            },
          },
        },
      },
      ...(effectiveScopes.length ? { security: [{ googleOAuth2: effectiveScopes }] } : {}),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: (typeof discovery.title === "string" && discovery.title) || `${service} Google API`,
      version,
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      schemas,
      ...(Object.keys(oauthScopes).length
        ? {
            securitySchemes: {
              googleOAuth2: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
                    tokenUrl: "https://oauth2.googleapis.com/token",
                    scopes: Object.fromEntries(
                      Object.entries(oauthScopes).map(([scope, metadata]) => [
                        scope,
                        typeof asRecord(metadata)?.description === "string"
                          ? asRecord(metadata)!.description
                          : "",
                      ]),
                    ),
                  },
                },
              },
            },
          }
        : {}),
    },
  };
}

export function bundleGoogleDiscoveryDocuments(
  inputs: readonly {
    readonly document: unknown;
    readonly service: GoogleService;
  }[],
): OpenApiDocument {
  const converted = inputs.map((input) =>
    convertGoogleDiscoveryDocument(input.document, input.service),
  );
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  const scopes: Record<string, string> = {};
  for (const document of converted) {
    for (const [path, item] of Object.entries(asRecord(document.paths) ?? {})) {
      paths[path] = { ...paths[path], ...asRecord(item) };
    }
    Object.assign(schemas, asRecord(asRecord(document.components)?.schemas) ?? {});
    const flow = asRecord(
      asRecord(
        asRecord(
          asRecord(asRecord(asRecord(document.components)?.securitySchemes)?.googleOAuth2)?.flows,
        )?.authorizationCode,
      )?.scopes,
    );
    Object.assign(scopes, flow ?? {});
  }
  return {
    openapi: "3.1.0",
    info: { title: "Google APIs", version: "1" },
    servers: [{ url: "https://www.googleapis.com/" }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        googleOAuth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
              tokenUrl: "https://oauth2.googleapis.com/token",
              scopes,
            },
          },
        },
      },
    },
  };
}
