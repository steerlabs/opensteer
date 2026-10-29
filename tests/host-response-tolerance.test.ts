import { RunnerChallengeSchema } from "../packages/protocol/src/runner.js";
import { HostApiErrorSchema, hostApi } from "../packages/protocol/src/host-api.js";
import {
  ClientToHostMessageSchema,
  HostToClientMessageSchema,
} from "../packages/protocol/src/client.js";
import {
  SessionExchangeRequestSchema,
  SessionExchangeResponseSchema,
} from "../packages/protocol/src/session-exchange.js";
import {
  CancelPersonalHostAccountLinkOperationResponseSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  ControlPlaneErrorResponseSchema,
  IssueAccountHostSessionGrantResponseSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  ListAccountDeploymentsResponseSchema,
  RemoveAccountDeploymentResponseSchema,
  UpdateAccountDeploymentNameResponseSchema,
} from "../packages/control-plane-protocol/src/index.js";
import { HostDiscoveryEnvelopeSchema } from "../packages/deployment-authority/src/authority.js";
import { PersonalHostAccessRouteEnvelopeSchema } from "../packages/deployment-authority/src/personal-access-route.js";
import {
  CloudDeploymentOperationSchema,
  ListCloudDeploymentsResponseSchema,
} from "../packages/control-plane-protocol/src/cloud.js";
import {
  ConnectCredentialResponseSchema,
  RevokeConnectResponseSchema,
} from "../packages/control-plane-protocol/src/connect.js";
import {
  HostNotificationPublicationResponseSchema,
  HostNotificationPublicationSchema,
  ListNotificationDevicesResponseSchema,
  RegisterNotificationDeviceRequestSchema,
  RegisterNotificationDeviceResponseSchema,
  UnregisterNotificationDeviceResponseSchema,
} from "../packages/control-plane-protocol/src/notifications.js";
import { isRecord } from "@opensteer/shared/isRecord";
import { describe, expect, it } from "vitest";

interface RuntimeSchemaDefinition {
  readonly [key: string]: unknown;
  readonly type: string;
}

interface RuntimeSchema {
  readonly _zod: {
    readonly def: RuntimeSchemaDefinition;
  };
}

interface SchemaLocation {
  readonly path: string;
  readonly schema: RuntimeSchema;
}

interface SchemaAudit {
  readonly strictObjectPaths: readonly string[];
  readonly visitedCount: number;
}

/**
 * Every contract a client parses as a response, not only the rpc graph. A
 * store-distributed app, a self-hosted Host and the Account all update on
 * their own schedules, so an additive field must never stop any of them: the
 * session exchange, the Account directory, Connect, Cloud and the notification
 * device registrations are as independently deployed as `hostApi` is.
 */
const responseRoots: SchemaLocation[] = [
  ...namedRoots({ RunnerChallengeSchema }),
  { path: "HostApiErrorSchema", schema: schemaAt(HostApiErrorSchema, "HostApiErrorSchema") },
  {
    path: "HostToClientMessageSchema",
    schema: schemaAt(HostToClientMessageSchema, "HostToClientMessageSchema"),
  },
  ...Object.entries(hostApi).flatMap(([name, declaration]) => [
    {
      path: `hostApi.${name}.success`,
      schema: schemaAt(declaration.success, `hostApi.${name}.success`),
    },
    {
      path: `hostApi.${name}.error`,
      schema: schemaAt(declaration.error, `hostApi.${name}.error`),
    },
  ]),
  ...namedRoots({
    CancelPersonalHostAccountLinkOperationResponseSchema,
    CloudDeploymentOperationSchema,
    CompletePersonalHostAccountLinkResponseSchema,
    ConnectCredentialResponseSchema,
    ControlPlaneErrorResponseSchema,
    HostNotificationPublicationResponseSchema,
    IssueAccountHostSessionGrantResponseSchema,
    IssuePersonalHostAccountLinkChallengeResponseSchema,
    ListAccountDeploymentsResponseSchema,
    ListCloudDeploymentsResponseSchema,
    ListNotificationDevicesResponseSchema,
    RegisterNotificationDeviceResponseSchema,
    RemoveAccountDeploymentResponseSchema,
    RevokeConnectResponseSchema,
    SessionExchangeResponseSchema,
    UnregisterNotificationDeviceResponseSchema,
    UpdateAccountDeploymentNameResponseSchema,
  }),
];

/**
 * Where the walk stops. A signed envelope is not a response shape: its bytes
 * carry a signature the client verifies, so an unknown field inside one is
 * material the signer put there and the exact schema is applied at the
 * connection boundary that verifies it. Loosening these would make the
 * verification admit shapes no key ever attested.
 */
const verifiedVerbatim = new Set<RuntimeSchema>([
  schemaAt(HostDiscoveryEnvelopeSchema, "HostDiscoveryEnvelopeSchema"),
  schemaAt(PersonalHostAccessRouteEnvelopeSchema, "PersonalHostAccessRouteEnvelopeSchema"),
]);

const responseAudit = auditSchemas(responseRoots, verifiedVerbatim);

describe("response tolerance", () => {
  it(`keeps all ${responseAudit.visitedCount} reachable response schemas tolerant of additive object fields`, () => {
    expect(
      responseAudit.strictObjectPaths,
      "Strict objects reject additive Host fields. Project shared strict models through an explicit tolerant *ViewSchema.",
    ).toEqual([]);
  });

  it("keeps every client request strict at its top level", () => {
    const violations = [
      ...Object.entries(hostApi).flatMap(([name, declaration]) =>
        topLevelStrictnessViolations(declaration.payload, `hostApi.${name}.payload`),
      ),
      ...topLevelStrictnessViolations(ClientToHostMessageSchema, "ClientToHostMessageSchema"),
      // The same boundary in the other direction: what a Host or the Account
      // parses as input stays strict, so tolerance never leaks across it.
      ...topLevelStrictnessViolations(SessionExchangeRequestSchema, "SessionExchangeRequestSchema"),
      ...topLevelStrictnessViolations(
        HostNotificationPublicationSchema,
        "HostNotificationPublicationSchema",
      ),
      ...topLevelStrictnessViolations(
        RegisterNotificationDeviceRequestSchema,
        "RegisterNotificationDeviceRequestSchema",
      ),
    ];

    expect(
      violations,
      "Client inputs must reject unknown top-level fields; unions must consist of strict object options.",
    ).toEqual([]);
  });
});

/**
 * Zod 4 keeps its runtime graph in `_zod.def`. Walking that graph directly
 * makes a newly shared strict input schema fail at the response boundary that
 * exposes it, including when wrappers or recursive lazy schemas hide it.
 */
function auditSchemas(
  roots: readonly SchemaLocation[],
  stopAt: ReadonlySet<RuntimeSchema>,
): SchemaAudit {
  const pending = [...roots].reverse();
  const strictObjectPaths: string[] = [];
  const visited = new Set<RuntimeSchema>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current.schema)) continue;
    visited.add(current.schema);
    if (stopAt.has(current.schema)) continue;

    if (isStrictObject(current.schema)) strictObjectPaths.push(current.path);

    const children = childSchemas(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push(child);
    }
  }

  return { strictObjectPaths: strictObjectPaths.sort(), visitedCount: visited.size };
}

function childSchemas(location: SchemaLocation): SchemaLocation[] {
  const { def } = location.schema._zod;
  const children = refinementSchemas(def, location.path);

  switch (def.type) {
    case "object": {
      const shape = recordAt(def["shape"], `${location.path} → [shape]`);
      for (const [name, schema] of Object.entries(shape)) {
        children.push({ path: `${location.path} → ${name}`, schema: schemaAt(schema, name) });
      }
      const catchall = def["catchall"];
      if (catchall !== undefined) {
        children.push({
          path: `${location.path} → [catchall]`,
          schema: schemaAt(catchall, `${location.path} catchall`),
        });
      }
      return children;
    }
    case "array":
      children.push(schemaProperty(def, "element", `${location.path} → []`));
      return children;
    case "union": {
      const options = schemaArrayAt(def["options"], `${location.path} options`);
      const discriminator = typeof def["discriminator"] === "string" ? def["discriminator"] : null;
      options.forEach((schema, index) => {
        children.push({
          path: `${location.path} → ${unionOptionLabel(schema, index, discriminator)}`,
          schema,
        });
      });
      return children;
    }
    case "intersection":
      children.push(
        schemaProperty(def, "left", `${location.path} → [left]`),
        schemaProperty(def, "right", `${location.path} → [right]`),
      );
      return children;
    case "tuple": {
      const items = schemaArrayAt(def["items"], `${location.path} tuple items`);
      items.forEach((schema, index) => {
        children.push({ path: `${location.path} → [${index}]`, schema });
      });
      const rest = def["rest"];
      if (rest !== null && rest !== undefined) {
        children.push({
          path: `${location.path} → [rest]`,
          schema: schemaAt(rest, `${location.path} tuple rest`),
        });
      }
      return children;
    }
    case "record":
    case "map":
      children.push(
        schemaProperty(def, "keyType", `${location.path} → [key]`),
        schemaProperty(def, "valueType", `${location.path} → [value]`),
      );
      return children;
    case "set":
      children.push(schemaProperty(def, "valueType", `${location.path} → [value]`));
      return children;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "success":
    case "catch":
    case "readonly":
    case "promise":
      children.push(schemaProperty(def, "innerType", `${location.path} → [inner]`));
      return children;
    case "lazy": {
      const getter = def["getter"];
      if (typeof getter !== "function") {
        throw new Error(`${location.path} has a lazy schema without a getter.`);
      }
      const inner: unknown = getter();
      children.push({ path: `${location.path} → [lazy]`, schema: schemaAt(inner, location.path) });
      return children;
    }
    case "pipe":
      children.push(
        schemaProperty(def, "in", `${location.path} → [input]`),
        schemaProperty(def, "out", `${location.path} → [output]`),
      );
      return children;
    case "function":
      children.push(
        schemaProperty(def, "input", `${location.path} → [arguments]`),
        schemaProperty(def, "output", `${location.path} → [return]`),
      );
      return children;
    case "template_literal": {
      const parts = arrayAt(def["parts"], `${location.path} template parts`);
      parts.forEach((part, index) => {
        if (isRuntimeSchema(part)) {
          children.push({ path: `${location.path} → [part ${index + 1}]`, schema: part });
        }
      });
      return children;
    }
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "transform":
    case "custom":
      return children;
    default:
      throw new Error(
        `${location.path} uses unsupported Zod schema type ${JSON.stringify(def.type)}; teach the response audit how to traverse it.`,
      );
  }
}

/** `.refine` stores a Zod custom schema in `checks`; scalar checks have no schema graph. */
function refinementSchemas(def: RuntimeSchemaDefinition, path: string): SchemaLocation[] {
  const checks = def["checks"];
  if (checks === undefined) return [];

  return arrayAt(checks, `${path} checks`).flatMap((check, index) =>
    isRuntimeSchema(check) ? [{ path: `${path} → [refinement ${index + 1}]`, schema: check }] : [],
  );
}

function topLevelStrictnessViolations(schema: unknown, path: string): string[] {
  const root = schemaAt(schema, path);
  const def = root._zod.def;

  if (def.type === "object") return isStrictObject(root) ? [] : [`${path} is not strict`];
  if (def.type !== "union") return [`${path} is ${def.type}, not a strict object or object union`];

  const options = schemaArrayAt(def["options"], `${path} options`);
  const discriminator = typeof def["discriminator"] === "string" ? def["discriminator"] : null;
  return options.flatMap((option, index) => {
    const optionPath = `${path} → ${unionOptionLabel(option, index, discriminator)}`;
    if (option._zod.def.type !== "object") {
      return [`${optionPath} is ${option._zod.def.type}, not an object`];
    }
    return isStrictObject(option) ? [] : [`${optionPath} is not strict`];
  });
}

function isStrictObject(schema: RuntimeSchema): boolean {
  const def = schema._zod.def;
  return (
    def.type === "object" &&
    isRuntimeSchema(def["catchall"]) &&
    def["catchall"]._zod.def.type === "never"
  );
}

function unionOptionLabel(
  schema: RuntimeSchema,
  index: number,
  discriminator: string | null,
): string {
  if (discriminator === null || schema._zod.def.type !== "object") return `[option ${index + 1}]`;
  const shape = schema._zod.def["shape"];
  if (!isRecord(shape)) return `[option ${index + 1}]`;
  const discriminant = shape[discriminator];
  if (!isRuntimeSchema(discriminant) || discriminant._zod.def.type !== "literal") {
    return `[option ${index + 1}]`;
  }
  const values = discriminant._zod.def["values"];
  if (!Array.isArray(values) || values.length !== 1) return `[option ${index + 1}]`;

  return `[${discriminator}=${JSON.stringify(values[0])}]`;
}

function schemaProperty(
  def: RuntimeSchemaDefinition,
  property: string,
  path: string,
): SchemaLocation {
  return { path, schema: schemaAt(def[property], path) };
}

/** Roots named by the binding they are exported under, so a failure says which. */
function namedRoots(schemas: Readonly<Record<string, unknown>>): SchemaLocation[] {
  return Object.entries(schemas).map(([path, schema]) => ({
    path,
    schema: schemaAt(schema, path),
  }));
}

function schemaAt(value: unknown, path: string): RuntimeSchema {
  if (!isRuntimeSchema(value)) throw new Error(`${path} is not a Zod 4 schema.`);
  return value;
}

function isRuntimeSchema(value: unknown): value is RuntimeSchema {
  if (!isRecord(value)) return false;
  const internals = value["_zod"];
  if (!isRecord(internals)) return false;
  const def = internals["def"];
  return isRecord(def) && typeof def["type"] === "string";
}

function schemaArrayAt(value: unknown, path: string): RuntimeSchema[] {
  return arrayAt(value, path).map((item, index) => schemaAt(item, `${path}[${index}]`));
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} is not an array.`);
  return value;
}

function recordAt(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${path} is not a record.`);
  return value;
}
