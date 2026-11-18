import { Effect, Schema } from "effect";
import { OpenapiCompileError, openapiToolNames, type CredentialBinding } from "apps/openapi";
import {
  openapiAppSource,
  type CredentialPlacement,
  type GeneratedAuthMethod,
} from "@opensteer/plugin-engine-app-templates";
import { SourceFiles } from "@opensteer/plugin-engine-sdk/core";
import { isRecord } from "@opensteer/shared/isRecord";
import { z } from "zod";

export const openapiNotices = z.array(z.string().min(1).max(1_000));
export const openapiNoticesFile = "openapi-import-notices.json";
export const disallowedOpenapiAddress = "This OpenAPI address is private or not allowed.";

const documentSchema = z.record(z.string(), z.json());
type Document = z.infer<typeof documentSchema>;
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
  "query",
]);

/** References are followed only within the fetched document. */
function resolve(document: Document, value: unknown) {
  let current = record(value);
  const seen = new Set<unknown>();
  while (typeof current.$ref === "string" && current.$ref.startsWith("#/")) {
    if (seen.has(current)) return {};
    seen.add(current);
    const path = current.$ref.slice(2).split("/");
    current = record(
      path.reduce<unknown>((node, part) => {
        const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
        return Object.hasOwn(record(node), key) ? record(node)[key] : undefined;
      }, document),
    );
  }
  return current;
}

function placement(scheme: Record<string, unknown>): CredentialPlacement | undefined {
  if (
    scheme.type === "apiKey" &&
    (scheme.in === "header" || scheme.in === "query") &&
    typeof scheme.name === "string" &&
    scheme.name.trim()
  )
    return { carrier: scheme.in, name: scheme.name, field: "token" };
  if (scheme.type === "http" && scheme.scheme === "bearer")
    return { carrier: "header", name: "Authorization", prefix: "Bearer ", field: "token" };
  return undefined;
}

function unsupported(name: string, scheme: Record<string, unknown>) {
  const kind =
    scheme.type === "apiKey"
      ? scheme.in === "cookie"
        ? "cookie API key"
        : "API key with an invalid placement"
      : scheme.type === "http"
        ? typeof scheme.scheme === "string"
          ? `HTTP ${scheme.scheme}`
          : "HTTP authentication"
        : typeof scheme.type === "string"
          ? scheme.type
          : "undeclared or unresolved scheme";
  return `${name} (${kind})`;
}

export function planOpenapiImport(document: Document) {
  const schemes = new Map(
    Object.entries(record(record(document.components).securitySchemes)).map(([name, scheme]) => [
      name,
      resolve(document, scheme),
    ]),
  );
  const supported = new Map(
    [...schemes].flatMap(([name, scheme]) => {
      const target = placement(scheme);
      return target ? [[name, target] as const] : [];
    }),
  );
  const alternatives = new Map<string, readonly string[]>();
  const excluded = new Map<string, string>();
  const operations = new Set<string>();
  const paths = Object.fromEntries(
    Object.entries(record(document.paths)).map(([path, original]) => {
      const item = resolve(document, original);
      const operation = (method: string, value: unknown): [string, unknown][] => {
        if (!isRecord(value)) return [[method, value]];
        const key = `${method.toUpperCase()} ${path}`;
        operations.add(key);
        const declared = value.security ?? document.security;
        if (declared === undefined || (Array.isArray(declared) && declared.length === 0))
          return [[method, { ...value, security: [] }]];
        const requirements = Array.isArray(declared)
          ? declared.filter(isRecord).map((requirement) => Object.keys(requirement).sort())
          : [];
        // An anonymous alternative needs no account and must never receive a credential.
        if (requirements.some((names) => names.length === 0))
          return [[method, { ...value, security: [] }]];
        const usable = requirements.filter((names) => names.every((name) => supported.has(name)));
        if (usable.length === 0) {
          const names = [...new Set(requirements.flat())]
            .filter((name) => !supported.has(name))
            .map((name) => unsupported(name, schemes.get(name) ?? {}));
          excluded.set(
            key,
            names.length
              ? `Unsupported authentication: ${names.join(", ")}.`
              : "Invalid OpenAPI security requirements.",
          );
          return [];
        }
        for (const names of usable) alternatives.set(JSON.stringify(names), names);
        return [
          [
            method,
            {
              ...value,
              security: usable.map((names) => Object.fromEntries(names.map((name) => [name, []]))),
            },
          ],
        ];
      };
      const entries = Object.entries(item).flatMap(([key, value]): [string, unknown][] => {
        if (methods.has(key)) return operation(key, value);
        if (key === "additionalOperations" && String(document.openapi).startsWith("3.2."))
          return [
            [
              key,
              Object.fromEntries(
                Object.entries(record(value)).flatMap(([method, definition]) =>
                  operation(method, definition),
                ),
              ),
            ],
          ];
        return [[key, value]];
      });
      return [path, Object.fromEntries(entries)];
    }),
  );
  const auth: Record<string, GeneratedAuthMethod> = {};
  const bindings: Record<string, CredentialBinding[]> = {};
  for (const names of alternatives.values()) {
    const method =
      Object.keys(auth).length === 0 ? "apiKey" : `apiKey${Object.keys(auth).length + 1}`;
    const fields = names.map((_, index) => (names.length === 1 ? "token" : `key${index + 1}`));
    auth[method] = {
      kind: "secrets",
      label:
        alternatives.size === 1 && names.length === 1 ? "API key" : names.join(" + ").slice(0, 240),
      fields,
      placements: names.map((name, index) => ({ ...supported.get(name)!, field: fields[index]! })),
    };
    bindings[method] = names.map((scheme, index) => ({
      scheme,
      field: fields[index]!,
      part: "value",
      prefix: "",
    }));
  }
  const securitySchemes = Object.fromEntries(
    [...supported.keys()].map((name) => [name, documentSchema.parse(schemes.get(name))]),
  );
  return {
    document: documentSchema.parse({ ...document, paths }),
    securitySchemes,
    auth,
    bindings,
    excluded,
    operations,
  };
}

// The template publishes the provider and seals its fields. This entry point lets the OpenAPI
// router choose credentials per operation instead of attaching every field to every request.
const authenticatedIndex = `import { accountRouter, defineApp, withApprovals } from "apps"
import { always } from "apps/operations/approval"
import { liveOpenapiRouter } from "apps/openapi"
import configuration from "./openapi.json"
import { provider } from "./provider"

export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user, cache, fetch, signal }) => {
  const accounts = user?.accounts.service ?? []
  const source = (account?: (typeof accounts)[number]) => withApprovals(
    liveOpenapiRouter({ ...configuration, cache, fetch, signal, account }),
    (tool) => tool.kind === "mutation" ? always() : undefined,
  )
  return { tools: accounts.length ? await accountRouter(accounts, source, { signal }) : source() }
})
`;

export function openapiImport(name: string, origin: string, raw: unknown, signal: AbortSignal) {
  return Effect.gen(function* () {
    const document = documentSchema.safeParse(raw);
    if (!document.success) return { error: "This address did not return an OpenAPI document." };
    const plan = planOpenapiImport(document.data);
    const settings = {
      source: { document: plan.document },
      allowedOrigin: origin,
      securitySchemes: plan.securitySchemes,
      methods: plan.bindings,
      oauth: [],
    };
    const notice = (operation: string, reason: string) =>
      `${operation} — ${reason}`.slice(0, 1_000);
    const warnings = [...plan.excluded].map(([operation, reason]) => notice(operation, reason));
    const result = yield* Effect.tryPromise({
      try: () => openapiToolNames({ ...settings, signal }),
      catch: (error) => error,
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      const error = result.failure;
      const details = Schema.is(OpenapiCompileError)(error)
        ? (error.skipped?.map((item) => notice(`${item.method} ${item.path}`, item.reason)) ?? [
            error.reason,
          ])
        : ["The OpenAPI document could not be read."];
      return { error: [...warnings, ...details].join("\n").slice(0, 4_000) };
    }
    const accounted = new Set([
      ...plan.excluded.keys(),
      ...result.success.tools.map((item) => `${item.method} ${item.path}`),
    ]);
    for (const item of result.success.skipped) {
      const operation = `${item.method} ${item.path}`;
      accounted.add(operation);
      warnings.push(
        notice(
          operation,
          item.code === "multiple_hosts"
            ? "Its server is on a different origin from the OpenAPI address."
            : item.reason,
        ),
      );
    }
    // Some compiled operations cannot produce a callable tool, such as event streams.
    for (const operation of plan.operations)
      if (!accounted.has(operation))
        warnings.push(notice(operation, "This operation cannot be exposed as a tool."));

    if (result.success.tools.length === 0)
      return {
        error:
          warnings.join("\n").slice(0, 4_000) || "The OpenAPI document has no usable operations.",
      };
    const used = new Set(result.success.tools.flatMap((tool) => tool.methods));
    const auth = Object.fromEntries(
      Object.entries(plan.auth).filter(([method]) => used.has(method)),
    );
    const generated = yield* openapiAppSource({
      name,
      document: plan.document,
      methods: auth,
      allowedOrigins: [origin],
    });
    const files =
      Object.keys(auth).length === 0
        ? [...generated.files]
        : generated.files.map((file) => {
            if (file.path === "index.ts") return { ...file, content: authenticatedIndex };
            if (file.path === "openapi.json")
              return {
                ...file,
                content: JSON.stringify({
                  ...settings,
                  methods: Object.fromEntries(
                    Object.entries(plan.bindings).filter(([method]) => used.has(method)),
                  ),
                }),
              };
            return file;
          });
    if (warnings.length)
      files.push({ path: openapiNoticesFile, content: JSON.stringify(warnings) });
    return {
      files: yield* Schema.decodeUnknownEffect(SourceFiles)(files),
      ...(warnings.length ? { warnings } : {}),
    };
  });
}
