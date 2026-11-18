import { legacyComputerTargetToDevice } from "./models.js";
import { DeviceIdSchema } from "@opensteer/core";
import { z } from "zod";
import { McpIdentifierSchema } from "./schema-primitives.js";
import {
  DeploymentIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  requestReasonMaxLength,
} from "@opensteer/core";
import { ComputerAppIdentitySchema, ComputerAppIdentityViewSchema } from "./computer-app.js";
import { IntegrationServerIdSchema } from "./ids.js";
import { IntegrationAccessSchema, type IntegrationAccess } from "./access.js";
import { LocalMcpLaunchSchema, LocalMcpLaunchViewSchema } from "./local-mcp.js";

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

const localMcpServerSetupShape = {
  installationTitle: z.string().trim().min(1).max(160),
  name: McpIdentifierSchema,
  serverId: IntegrationServerIdSchema,
} as const;

/** An installed MCP server a Mac is asked to run, exactly as it will run it. */
export const LocalMcpServerSetupSchema = z.strictObject({
  ...localMcpServerSetupShape,
  launch: LocalMcpLaunchSchema,
});
export type LocalMcpServerSetup = z.infer<typeof LocalMcpServerSetupSchema>;

/**
 * A durable request to review access to a computer. It never starts an
 * agent. `definitionId` names what is approved: a catalog definition, or for
 * `kind: "server"` the installed MCP server, whose launch `definitionDigest`
 * pins (`localMcpLaunchDigest`).
 */
const computerAppSetupRequestShapeSchema = z.strictObject({
  id: z.uuid(),
  deploymentId: DeploymentIdSchema,
  ownerUserId: UserIdSchema,
  runnerId: RunnerIdSchema,
  definitionId: z.string().min(1).max(64),
  definitionDigest: z.string().min(1).max(128),
  access: IntegrationAccessSchema,
  kind: z.enum(["app", "policy", "server"]),
  policyAppApproval: z.literal("automatic").nullable(),
  app: ComputerAppIdentitySchema.nullable(),
  /** Only a `kind: "server"` request names one; every other kind has none. */
  server: LocalMcpServerSetupSchema.nullable().default(null),
  reason: z.string().max(requestReasonMaxLength).nullable(),
  threadId: ThreadIdSchema.nullable(),
  /** The name the panel shows, fixed when this request was created. */
  threadTitle: z.string().max(240).nullable(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
function validComputerAppSetupKind(request: {
  readonly access: IntegrationAccess;
  readonly app: unknown;
  readonly definitionId: string;
  readonly kind: "app" | "policy" | "server";
  readonly policyAppApproval: "automatic" | null;
  readonly server: { readonly serverId: string } | null;
}): boolean {
  if (request.kind === "server") {
    return (
      request.server !== null &&
      request.definitionId === request.server.serverId &&
      request.app === null &&
      request.policyAppApproval === null &&
      request.access === "read-write"
    );
  }
  if (request.server !== null) return false;
  return request.kind === "app"
    ? request.policyAppApproval === null
    : request.policyAppApproval === "automatic" &&
        request.app === null &&
        request.definitionId === "macos-app" &&
        request.access === "read-write";
}
export const ComputerAppSetupRequestSchema = computerAppSetupRequestShapeSchema.refine(
  validComputerAppSetupKind,
  "Setup request scope must match its kind",
);
export const ComputerAppSetupRequestViewSchema = z.object({
  ...computerAppSetupRequestShapeSchema.shape,
  server: z.object(localMcpServerSetupShape).nullable(),
  app: ComputerAppIdentityViewSchema.nullable(),
});
/** Transient owner-only review; callers must not persist it in client snapshots. */
export const ComputerAppSetupReviewRequestViewSchema = z.object({
  ...ComputerAppSetupRequestViewSchema.shape,
  server: z.object({ ...localMcpServerSetupShape, launch: LocalMcpLaunchViewSchema }).nullable(),
});
export type ComputerAppSetupSummary = z.infer<typeof ComputerAppSetupRequestViewSchema>;
export type ComputerAppSetupRequest = z.infer<typeof ComputerAppSetupRequestSchema>;

const computerAppSetupInputSchema = z.strictObject({
  kind: z.literal("app"),
  access: IntegrationAccessSchema,
  app: ComputerAppIdentitySchema.nullable(),
  definitionId: z.string().min(1).max(64),
  runnerId: RunnerIdSchema,
});
const computerPolicySetupInputSchema = z.strictObject({
  kind: z.literal("policy"),
  appApproval: z.literal("automatic"),
  runnerId: RunnerIdSchema,
});
export const RequestComputerAppSetupSchema = z.discriminatedUnion("kind", [
  computerAppSetupInputSchema,
  computerPolicySetupInputSchema,
]);
/**
 * The owner may keep or lower a Mac app's access from any client. Creating,
 * widening or unblocking a Mac app, and turning automatic approval on, require
 * the computer owner's authenticated Host command. The owner may also
 * create or widen an Android phone's connection from any client.
 */
export const SetComputerAppConnectionSchema = computerAppSetupInputSchema;
export type SetComputerAppConnection = z.infer<typeof SetComputerAppConnectionSchema>;

export const DeviceComputerAppSetupRequestSchema = computerAppSetupRequestShapeSchema
  .omit({ runnerId: true })
  .extend({ deviceId: DeviceIdSchema })
  .refine(validComputerAppSetupKind, "Setup request scope must match its kind");
export type DeviceComputerAppSetupRequest = z.infer<typeof DeviceComputerAppSetupRequestSchema>;
export const DeviceComputerAppSetupRequestReaderSchema = z.union([
  DeviceComputerAppSetupRequestSchema,
  ComputerAppSetupRequestSchema.transform(legacyComputerTargetToDevice),
]);
export const DeviceComputerAppSetupRequestViewSchema = ComputerAppSetupRequestViewSchema.omit({
  runnerId: true,
}).extend({ deviceId: DeviceIdSchema });
export const DeviceSetComputerAppConnectionSchema = computerAppSetupInputSchema
  .omit({ runnerId: true })
  .extend({ deviceId: DeviceIdSchema });
export type DeviceSetComputerAppConnection = z.infer<typeof DeviceSetComputerAppConnectionSchema>;
export const DeviceRequestComputerAppSetupSchema = z.discriminatedUnion("kind", [
  DeviceSetComputerAppConnectionSchema,
  computerPolicySetupInputSchema.omit({ runnerId: true }).extend({ deviceId: DeviceIdSchema }),
]);
export type DeviceRequestComputerAppSetup = z.infer<typeof DeviceRequestComputerAppSetupSchema>;
export const DeviceRequestComputerAppSetupReaderSchema = z.union([
  DeviceRequestComputerAppSetupSchema,
  RequestComputerAppSetupSchema.transform(legacyComputerTargetToDevice),
]);

export const DeviceComputerAppSetupReviewRequestViewSchema =
  ComputerAppSetupReviewRequestViewSchema.omit({ runnerId: true }).extend({
    deviceId: DeviceIdSchema,
  });
export const DeviceSetComputerAppConnectionReaderSchema = z.union([
  DeviceSetComputerAppConnectionSchema,
  SetComputerAppConnectionSchema.transform(legacyComputerTargetToDevice),
]);
export const DeviceComputerPolicySetupSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  appApproval: z.enum(["ask", "automatic"]),
});
export type DeviceComputerPolicySetup = z.infer<typeof DeviceComputerPolicySetupSchema>;
