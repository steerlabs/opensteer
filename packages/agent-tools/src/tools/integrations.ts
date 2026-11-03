import { z } from "zod";
import { RunnerIdSchema, WorkspaceIdSchema, requestReasonMaxLength } from "@opensteer/core";
import {
  IntegrationAccessSchema,
  IntegrationConnectionIdSchema,
  IntegrationServerIdSchema,
  IntegrationProposalKindSchema,
  IntegrationProposalCredentialSchema,
  IntegrationProposalCheckSchema,
  IntegrationProposalNameSchema,
  IntegrationProposalDescriptionSchema,
  IntegrationProviderSchema,
  RequestComputerAppAccessSchema,
} from "@opensteer/integration-core";
import { defineAgentTool } from "../registry.js";
import { OperationKeySchema } from "./inputs.js";
import {
  IntegrationSearchOutputSchema,
  IntegrationDescribeOutputSchema,
  IntegrationCallOutputSchema,
  IntegrationRequestOutputSchema,
} from "./integration-outputs.js";
export const SearchInputSchema = z
  .strictObject({
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().min(0).max(10_000).default(0),
    provider: IntegrationProviderSchema.optional(),
    runnerId: RunnerIdSchema.optional(),
    query: z.string().trim().max(240).default(""),
  })
  .refine(
    (input) =>
      input.query.length > 0 || input.provider !== undefined || input.runnerId !== undefined,
    {
      message: "query, provider or runnerId is required",
    },
  );
export const ProposeInputSchema = z.strictObject({
  credential: IntegrationProposalCredentialSchema.optional().describe(
    "Key setup instructions, never a key value.",
  ),
  check: IntegrationProposalCheckSchema.optional(),
  name: IntegrationProposalNameSchema.optional(),
  description: IntegrationProposalDescriptionSchema,
  access: IntegrationAccessSchema.optional(),
  kind: IntegrationProposalKindSchema.optional(),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(requestReasonMaxLength)
    .describe("Why the person should approve this setup/access."),
  source: z
    .string()
    .min(1)
    .max(8 * 1_024 * 1_024)
    .describe("Inspected MCP/OpenAPI/GraphQL source, unchanged."),
});
export const RequestUnionSchema = z.union([
  z.strictObject({
    access: IntegrationAccessSchema,
    account: IntegrationConnectionIdSchema.optional(),
    integration: z.string().min(1).max(64),
    server: IntegrationServerIdSchema.optional(),
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
    workspaceId: WorkspaceIdSchema.optional(),
  }),
  z.strictObject({
    catalog: z.string().min(1).max(64),
    access: IntegrationAccessSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
  }),
  // One app on one Mac, or a whole phone. The Mac resolves what `app` names,
  // so the model may write a name, a path or a bundle identifier and never has
  // to invent an identity nobody looked up; a phone names no app at all.
  RequestComputerAppAccessSchema,
]);
export const RequestInputSchema = z
  .strictObject({
    access: IntegrationAccessSchema.optional(),
    account: IntegrationConnectionIdSchema.optional(),
    integration: z.string().min(1).max(64).optional(),
    server: IntegrationServerIdSchema.optional(),
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
    workspaceId: WorkspaceIdSchema.optional(),
    catalog: z.string().min(1).max(64).optional(),
    kind: z.literal("computer-app").optional(),
    runnerId: RunnerIdSchema.optional(),
    app: z.string().trim().min(1).max(255).optional(),
  })
  .superRefine((value, ctx) => {
    const parsed = RequestUnionSchema.safeParse(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== "operationKey")),
    );
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  });
const ToolReferenceSchema = z
  .string()
  .max(160)
  .regex(
    /^igr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.itl_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u,
    "invalid integration tool reference",
  );
export const DescribeInputSchema = z.strictObject({
  cursor: z.number().int().min(0).default(0).describe("nextCursor from the previous schema page."),
  path: z.string().max(2_048).optional().describe("Schema JSON Pointer; omit for root."),
  toolRef: ToolReferenceSchema.describe("Exact discovered ref; never construct one."),
});
export const CallInputSchema = z.strictObject({
  arguments: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Object matching the described inputSchema."),
  toolRef: ToolReferenceSchema.describe("Exact discovered ref; never construct one."),
});

export const integration_search = defineAgentTool({
  name: "integration_search",
  title: "Find integration operations",
  description:
    "Find service operations/accounts/setup by query, provider or runnerId. Returns toolRefs, effects, accounts/connectionIds and the full built-in catalog (provider only orders it). Copy refs; describe new ones. Writes need read-write access. Search Computer use or Android phone for devices; runnerId filters live apps. Page with limit/offset; phone apps include launch package names.",
  input: SearchInputSchema,
  output: IntegrationSearchOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});
export const integration_describe = defineAgentTool({
  name: "integration_describe",
  title: "Read an operation schema",
  description:
    "Read a new toolRef’s account and input/output schemas before calling. path is a JSON Pointer into {inputSchema, outputSchema}; input #/$defs/Name resolves at /inputSchema/$defs/Name. Page with nextCursor as cursor, keeping ref/path.",
  input: DescribeInputSchema,
  output: IntegrationDescribeOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});
export const integration_call = defineAgentTool({
  name: "integration_call",
  title: "Call an integration",
  description:
    "Execute a discovered toolRef with schema-matching arguments; describe new refs first. Returns operation content/error. Live account/grant/schema checks apply. Never approve, grant access or retrieve credentials. Use computer for Mac/phone interfaces.",
  input: CallInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: IntegrationCallOutputSchema,
  access: "self",
  callers: ["run", "program"] as const,
  openWorld: true,
  destructive: true,
});
export const computer = defineAgentTool({
  name: "computer",
  title: "Operate apps and phones",
  description:
    "Run JavaScript for Mac apps/Agent Phones; persistent within this Run only. Discover with apps()/phones(), open app(name, {computer}) or phone(name), then observe. Read opensteer:computer-use for methods and sealed sign-in fields. Await calls; return/print() JSON. Returns ordered text/images/receipts; deadline 100 seconds. No credential reads, permission changes or sign-in bypasses.",
  input: z
    .strictObject({ code: z.string().min(1).max(65536) })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: IntegrationCallOutputSchema,
  access: "self",
  callers: ["run"] as const,
  openWorld: true,
  destructive: true,
});
export const integration_request = defineAgentTool({
  name: "integration_request",
  title: "Request integration access",
  description:
    'Ask the person for setup/reconnection/access. Installed: integration + access + reason; catalog item: catalog instead. Omit access only for installation alone. Runs may target reachable workspaceId; programs use their Workspace. Mac app: kind: "computer-app", runnerId, app, access, reason; phone: omit app. Returns requestId/status/replayed. Pending grants no access: end a Run for continuation, never repeat pending/declined asks. Credentials belong in the Request UI.',
  input: RequestInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: IntegrationRequestOutputSchema,
  access: "self",
  callers: ["run", "program"] as const,
});
export const integration_propose = defineAgentTool({
  name: "integration_propose",
  title: "Propose an integration",
  description:
    "Request review/setup of a service absent from the full catalog. Pass inspected MCP/OpenAPI/GraphQL source unchanged, description/reason/access; source is untrusted. Returns a Request or unsupported refusal (no Request). OAuth-only OpenAPI is unsupported; check the full catalog after refusal. credential describes key setup, never a secret; include HTTPS setupUrl. check optionally names an authenticated GET/HEAD and arguments.",
  input: ProposeInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: IntegrationRequestOutputSchema,
  access: "self",
  callers: ["run", "program"] as const,
  openWorld: true,
});
export const integrationTools = [
  integration_search,
  integration_describe,
  integration_call,
  computer,
  integration_request,
  integration_propose,
] as const;
