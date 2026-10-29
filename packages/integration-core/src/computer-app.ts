import { z } from "zod";
import type { IntegrationDefinition } from "./adapter.js";
import type { AuthMethod } from "./auth-method.js";
import { JsonObjectSchema, McpIdentifierSchema } from "./schema-primitives.js";

export const ComputerUseAppApprovalSchema = z.enum(["ask", "automatic"]);
export type ComputerUseAppApproval = z.infer<typeof ComputerUseAppApprovalSchema>;

export const ComputerAppPlatformSchema = z.enum(["android", "darwin", "ios", "linux", "win32"]);
export type ComputerAppPlatform = z.infer<typeof ComputerAppPlatformSchema>;

/** Understood presentation values; executable definitions use the strict platform schema. */
export const ComputerAppPlatformViewSchema = ComputerAppPlatformSchema;
export type ComputerAppPlatformView = z.infer<typeof ComputerAppPlatformViewSchema>;

export {
  ComputerAppBundleIdSchema,
  ComputerAppTeamIdSchema,
  ComputerAppIdentitySchema,
  ComputerAppIdentityViewSchema,
  type ComputerAppIdentity,
} from "@opensteer/core";
import { type ComputerAppIdentity } from "@opensteer/core";

/**
 * The uniqueness key of one approved app.
 *
 * macOS resolves bundle identifiers case-insensitively, so two spellings must
 * never become two approvals, two connections and two grants for one app. The
 * team and the display name are recorded facts about the app, never part of
 * the key: an app that is re-signed or renamed stays the same connection.
 */
export function computerAppIdentityKey(identity: ComputerAppIdentity): string {
  return identity.bundleId.toLowerCase();
}

/** Whether two values name the same complete reviewed identity; bundle-id case is not identity. */
export function computerAppIdentitiesEqual(
  left: ComputerAppIdentity | null,
  right: ComputerAppIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    computerAppIdentityKey(left) === computerAppIdentityKey(right) &&
    left.displayName === right.displayName &&
    left.teamId === right.teamId
  );
}

export const ComputerAppOperationSchema = z.strictObject({
  description: z.string().min(1).max(16_384),
  effect: z.enum(["read", "write"]),
  inputSchema: JsonObjectSchema,
  name: McpIdentifierSchema,
  outputSchema: JsonObjectSchema.nullable(),
  title: z.string().trim().min(1).max(160),
});
export type ComputerAppOperation = z.infer<typeof ComputerAppOperationSchema>;

const accessLabelsShape = {
  read: z.string().min(1).max(40),
  readWrite: z.string().min(1).max(40),
} as const;
const accessSummariesShape = {
  read: z.string().min(1).max(240),
  readWrite: z.string().min(1).max(240),
} as const;

/**
 * What kind of computer app this is, present only when it is not the ordinary
 * one.
 *
 * Both kinds are operated rather than called: their operations travel on the
 * computer-use frame inside a session the Host owns, and the Host resolves the
 * target and the access from the connection instead of taking them as
 * arguments.
 *
 * - `gui` names one app's interface on a computer that keeps working for its
 *   person: its connection carries a `ComputerAppIdentity`, and a session holds
 *   that one app.
 * - `display` names a whole screen, the way a phone dedicated to agents is
 *   used: its connection carries no app, and a session holds the entire
 *   display, because two apps on one phone still share one foreground and one
 *   set of fingers.
 *
 * Absent is the default — Messages and every app like it — so no existing
 * definition changes.
 */
export const ComputerAppKindSchema = z.enum(["gui", "display"]);
export type ComputerAppKind = z.infer<typeof ComputerAppKindSchema>;

/** Whether this computer app is operated inside a Host-owned session on the computer-use frame. */
export function computerAppUsesSessions(config: Pick<ComputerAppConfig, "kind">): boolean {
  return config.kind === "gui" || config.kind === "display";
}

/** Whether every connection of this computer app names one app by its identity. */
export function computerAppNamesApp(config: Pick<ComputerAppConfig, "kind">): boolean {
  return config.kind === "gui";
}

export const ComputerAppConfigSchema = z
  .strictObject({
    accessLabels: z.strictObject(accessLabelsShape),
    kind: ComputerAppKindSchema.optional(),
    operations: z.array(ComputerAppOperationSchema).min(1).max(64),
    accessSummaries: z.strictObject(accessSummariesShape),
    platforms: z.array(ComputerAppPlatformSchema).min(1).max(4),
  })
  .superRefine((config, context) => {
    const names = new Set<string>();
    for (const [index, operation] of config.operations.entries()) {
      if (names.has(operation.name)) {
        context.addIssue({
          code: "custom",
          message: `Computer app operation ${operation.name} is declared more than once`,
          path: ["operations", index, "name"],
        });
      }
      names.add(operation.name);
    }
  });
export type ComputerAppConfig = z.infer<typeof ComputerAppConfigSchema>;

export const ComputerAppPresentationSchema = z.strictObject({
  accessLabels: z.strictObject(accessLabelsShape),
  accessLevels: z.union([
    z.tuple([z.literal("read")]),
    z.tuple([z.literal("read"), z.literal("read-write")]),
  ]),
  accessSummaries: z.strictObject(accessSummariesShape),
  kind: ComputerAppKindSchema.optional(),
  operations: z
    .array(ComputerAppOperationSchema.pick({ effect: true, name: true }))
    .min(1)
    .max(64),
  platforms: z.array(ComputerAppPlatformSchema).min(1).max(4),
});
export const ComputerAppPresentationViewSchema = z.object({
  ...ComputerAppPresentationSchema.shape,
  accessLabels: z.object(accessLabelsShape),
  accessSummaries: z.object(accessSummariesShape),
  operations: z
    .array(z.object(ComputerAppOperationSchema.pick({ effect: true, name: true }).shape))
    .min(1)
    .max(64),
  platforms: z
    .array(z.string())
    .max(16)
    .transform((platforms) =>
      platforms.filter((platform) => ComputerAppPlatformViewSchema.safeParse(platform).success),
    )
    .pipe(z.array(ComputerAppPlatformViewSchema)),
});
export type ComputerAppPresentation = z.infer<typeof ComputerAppPresentationSchema>;
export type ComputerAppPresentationView = z.infer<typeof ComputerAppPresentationViewSchema>;

type ComputerAuthMethod = Extract<AuthMethod, { readonly kind: "computer" }>;

export type ComputerAppDefinition = Omit<
  IntegrationDefinition,
  "adapter" | "authMethods" | "config"
> & {
  readonly adapter: "computer";
  readonly authMethods: [ComputerAuthMethod];
  readonly config: ComputerAppConfig;
};

export function computerAppAccessLevels(
  config: ComputerAppConfig,
): ["read"] | ["read", "read-write"] {
  return config.operations.some(({ effect }) => effect === "write")
    ? ["read", "read-write"]
    : ["read"];
}

export function computerAppPresentation(config: ComputerAppConfig): ComputerAppPresentation {
  return {
    accessLabels: config.accessLabels,
    accessLevels: computerAppAccessLevels(config),
    accessSummaries: config.accessSummaries,
    ...(config.kind === undefined ? {} : { kind: config.kind }),
    operations: config.operations.map(({ effect, name }) => ({ effect, name })),
    platforms: config.platforms,
  };
}

export function isComputerAppDefinition(
  definition: IntegrationDefinition,
): definition is ComputerAppDefinition {
  return (
    definition.adapter === "computer" &&
    definition.authMethods.length === 1 &&
    definition.authMethods[0]?.kind === "computer" &&
    ComputerAppConfigSchema.safeParse(definition.config).success
  );
}

export function parseComputerAppConfig(definition: IntegrationDefinition): ComputerAppConfig {
  if (definition.adapter !== "computer") {
    throw new Error(`Integration definition ${definition.id} is not a computer app`);
  }
  return ComputerAppConfigSchema.parse(definition.config);
}
