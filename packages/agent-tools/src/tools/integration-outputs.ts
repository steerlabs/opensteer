import { z } from "zod";

const ReadinessSchema = z.object({
  code: z.string(),
  connectionId: z.string().optional(),
  requiredAccess: z.string().optional(),
  detail: z.string().optional(),
  serverId: z.string().optional(),
});
const AppSchema = z.object({
  name: z.string().optional(),
  bundleId: z.string().optional(),
  packageName: z.string().optional(),
  label: z.string().optional(),
  identity: z
    .object({
      displayName: z.string(),
      bundleId: z.string().optional(),
      packageName: z.string().optional(),
    })
    .optional(),
  access: z.string().optional(),
  status: z.string().optional(),
  blocked: z.boolean().optional(),
  callable: z.boolean().optional(),
  pending: z.string().optional(),
  inUse: z.boolean().optional(),
  heldByThread: z.string().optional(),
});
const ComputerSchema = z.object({
  runnerId: z.string(),
  name: z.string(),
  state: z.string(),
  appApproval: z.string().optional(),
  computerToolEnabled: z.boolean(),
  computerUseVersion: z.number().nullable().optional(),
  apps: z.array(AppSchema).optional(),
});
const PhoneSchema = z.object({
  runnerId: z.string(),
  name: z.string(),
  state: z.string(),
  approval: z.string(),
  access: z.string().optional(),
  inUse: z.boolean().optional(),
  callable: z.boolean(),
  computerToolEnabled: z.boolean(),
  heldByThread: z.string().optional(),
});
export const IntegrationSearchOutputSchema = z.object({
  guidance: z
    .object({
      catalog: z.string().optional(),
      readiness: z.string().optional(),
      computers: z.string().optional(),
      phones: z.string().optional(),
    })
    .optional(),
  catalog: z
    .array(
      z.object({
        definitionId: z.string(),
        description: z.string(),
        integration: z.string(),
        installed: z.boolean(),
        installationId: z.string().optional(),
        installationStatus: z.string().optional(),
        statusDetail: z.string().nullable().optional(),
        computers: z.array(ComputerSchema).optional(),
        phones: z.array(PhoneSchema).optional(),
      }),
    )
    .optional(),
  operations: z
    .array(
      z.object({
        account: z.string(),
        connectionId: z.string().nullable(),
        effect: z.string(),
        integration: z.string(),
        name: z.string(),
        title: z.string().optional(),
        toolRef: z.string(),
      }),
    )
    .optional(),
  operationNextOffset: z.number().nullable().optional(),
  operationTotal: z.number().optional(),
  results: z
    .array(
      z.object({
        accounts: z.array(
          z.object({
            account: z.string(),
            connectionId: z.string(),
            alias: z.string().optional(),
            isDefault: z.boolean().optional(),
            status: z.string().optional(),
            access: z.string().optional(),
            readiness: ReadinessSchema.optional(),
          }),
        ),
        description: z.string(),
        integration: z.string(),
        name: z.string(),
        installationId: z.string(),
        servers: z.array(
          z.object({
            readiness: ReadinessSchema.optional(),
            server: z.string(),
            serverId: z.string(),
          }),
        ),
        toolCount: z.number(),
        tools: z.array(
          z.object({
            effect: z.string(),
            name: z.string(),
            readiness: ReadinessSchema.optional(),
            title: z.string().optional(),
          }),
        ),
        truncated: z.boolean().optional(),
      }),
    )
    .optional(),
  computer: ComputerSchema.optional(),
  apps: z.array(AppSchema).optional(),
  total: z.number(),
  nextOffset: z.number().nullable(),
});
export const IntegrationDescribeOutputSchema = z.object({ description: z.string() });
// Content is provider data, already checked against the operation's pinned output
// schema by the integration platform. The Host envelope is projected independently.
export const IntegrationCallOutputSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
      z.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export const IntegrationRequestOutputSchema = z.object({
  status: z.string(),
  kind: z.string().optional(),
  replayed: z.boolean().optional(),
  requestId: z.string().nullable().optional(),
  alreadyGranted: z.boolean().optional(),
  nextAction: z.string().optional(),
  guidance: z.string().optional(),
  authNote: z.string().optional(),
  selectedAuth: z.enum(["api-key", "mcp-oauth", "none"]).optional(),
  reason: z.string().optional(),
  detectedAuth: z.string().optional(),
  catalogAlternatives: z.array(z.string()).optional(),
});
