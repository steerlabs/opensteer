import { z } from "zod";
import { RunnerIdSchema, requestReasonMaxLength } from "@opensteer/core";
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
  IntegrationGrantIdSchema,
  IntegrationInstallationIdSchema,
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
    cursor: z
      .string()
      .regex(/^\d{1,5}$/u)
      .transform(Number)
      .pipe(z.number().int().max(10_000))
      .optional()
      .describe("nextCursor from the previous page."),
    provider: IntegrationProviderSchema.optional(),
    computerId: RunnerIdSchema.optional().describe(
      "A Mac or phone from this search's computers or phones, to list its installed apps.",
    ),
    query: z.string().trim().max(240).default(""),
  })
  .refine(
    (input) =>
      input.query.length > 0 || input.provider !== undefined || input.computerId !== undefined,
    { message: "query, provider or computerId is required" },
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
  }),
  z.strictObject({
    catalog: z.string().min(1).max(64),
    access: IntegrationAccessSchema.optional(),
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
  }),
]);
export const RequestInputSchema = z
  .strictObject({
    access: IntegrationAccessSchema.optional(),
    account: IntegrationConnectionIdSchema.optional(),
    integration: z.string().min(1).max(64).optional(),
    server: IntegrationServerIdSchema.optional().describe(
      "isv_ serverId from integration_search; omit for single-server installs.",
    ),
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
    catalog: z.string().min(1).max(64).optional(),
    operationKey: OperationKeySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const { operationKey: _operationKey, ...request } = value;
    const parsed = RequestUnionSchema.safeParse(request);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  });
/** One app on one Mac, or a whole phone. The Mac resolves what `app` names. */
export const AppAccessRequestInputSchema = z
  .strictObject({
    computerId: RunnerIdSchema.optional().describe(
      "The Mac or phone; omit for an app on the Mac this task runs on.",
    ),
    app: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("Mac app name, path or bundle ID; omit for a phone."),
    access: IntegrationAccessSchema,
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
    operationKey: OperationKeySchema.optional(),
  })
  .refine((input) => input.app !== undefined || input.computerId !== undefined, {
    message: "Name the app on a Mac, or the phone by its computerId",
    path: ["app"],
  });
const OperationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(528)
  .describe("Operation name exactly as integration_search returned it.");
const OperationAccountSchema = IntegrationConnectionIdSchema.optional().describe(
  "connectionId of the account to act as. Required unless the operation has no account.",
);
export const DescribeInputSchema = z.strictObject({
  account: OperationAccountSchema,
  cursor: z.number().int().min(0).default(0).describe("nextCursor from the previous schema page."),
  operation: OperationNameSchema,
  path: z.string().max(2_048).optional().describe("Schema JSON Pointer; omit for root."),
});
export const CallInputSchema = z.strictObject({
  account: OperationAccountSchema,
  arguments: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Object matching the operation's input."),
  operation: OperationNameSchema,
});

export const integration_search = defineAgentTool({
  name: "integration_search",
  title: "Find integration operations",
  description:
    "Find service operations, accounts and setup by query, provider or computerId. Returns each operation's name, effect and input, the accounts with their connectionIds, and every built-in catalog id, with details for matches. Tell personal and work accounts apart by their address, never by display name alone, and choose accounts by connectionId. Writes need read-write access. Search Computer use or Android phone for Macs and phones, then pass a computerId to list its installed apps; phone apps include launch package names.",
  input: SearchInputSchema,
  output: IntegrationSearchOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const integration_describe = defineAgentTool({
  name: "integration_describe",
  title: "Read an operation schema",
  description:
    "Read an operation's full input and output schemas when the search's input is not enough or ends in `…`. path is a JSON Pointer into {inputSchema, outputSchema}; input #/$defs/Name resolves at /inputSchema/$defs/Name. Page with nextCursor as cursor, keeping operation and path.",
  input: DescribeInputSchema,
  output: IntegrationDescribeOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const integration_call = defineAgentTool({
  name: "integration_call",
  title: "Call an integration",
  description:
    "Run an operation integration_search returned, as an account, with arguments matching its input. Live account and grant checks apply and this never grants access. A person's request to sign in covers retrieving its SMS or email code; other credentials stay in the Request. Use computer_use for Mac apps and phones.",
  input: CallInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: IntegrationCallOutputSchema,
  access: "write",
  callers: ["run", "program"] as const,
  openWorld: true,
  destructive: true,
});
export const integration_list = defineAgentTool({
  name: "integration_list",
  title: "List integrations",
  description:
    "List the person's installed integrations, connected accounts and the access grants your Opensteer holds. Never includes credentials.",
  input: z.strictObject({}),
  output: z.object({
    connections: z.array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        status: z.string(),
        provider: z.string().optional(),
        definitionId: z.string().optional(),
      }),
    ),
    grants: z.array(
      z.object({
        id: z.string(),
        connectionId: z.string().nullable(),
        installationId: z.string(),
        alias: z.string(),
        access: z.string(),
        status: z.string(),
      }),
    ),
    installations: z.array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        definitionId: z.string().optional(),
      }),
    ),
  }),
  access: "read",
  callers: ["run", "connection"] as const,
});
export const integration_remove = defineAgentTool({
  name: "integration_remove",
  title: "Remove an integration",
  description:
    "Disconnect an account, uninstall an integration or revoke an access grant, using IDs from integration_list. Adding accounts, credentials and grants back needs integration_request and the person.",
  input: z
    .strictObject({
      target: z.enum(["account", "integration", "grant"]),
      connectionId: IntegrationConnectionIdSchema.optional().describe("account: the connection."),
      installationId: IntegrationInstallationIdSchema.optional().describe(
        "integration: the installed integration.",
      ),
      grantId: IntegrationGrantIdSchema.optional().describe("grant: the grant."),
    })
    .superRefine((input, context) => {
      const fields = {
        account: input.connectionId,
        integration: input.installationId,
        grant: input.grantId,
      };
      for (const [target, id] of Object.entries(fields))
        if ((input.target === target) !== (id !== undefined))
          context.addIssue({
            code: "custom",
            message: "Name exactly the ID that matches target",
          });
    }),
  output: z.object({ ok: z.literal(true) }),
  access: "settings",
  callers: ["run", "connection"] as const,
  destructive: true,
});
export const integration_request = defineAgentTool({
  name: "integration_request",
  title: "Request integration access",
  description:
    "Ask the person to set up, reconnect or grant access to a service. For an installed integration pass integration, access and reason; for a catalog item pass catalog instead, omitting access only to install it alone. Access is personal and pending grants none. Never repeat a pending or declined ask; credentials belong in the Request. Mac apps and phones use app_access_request; a service missing from the catalog uses custom_integration_request.",
  input: RequestInputSchema,
  output: IntegrationRequestOutputSchema,
  access: "write",
  callers: ["run", "program"] as const,
});
export const app_access_request = defineAgentTool({
  name: "app_access_request",
  title: "Request a Mac app or phone",
  description:
    "Ask the person to let this task use one Mac app, or a whole Agent Phone, through computer_use. For a Mac app pass app and, unless it is on the Mac this task runs on, its computerId; for a phone pass only its computerId. read observes and read-write also acts. Pending grants no access; never repeat a pending or declined ask.",
  input: AppAccessRequestInputSchema,
  output: IntegrationRequestOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
export const custom_integration_request = defineAgentTool({
  name: "custom_integration_request",
  title: "Request a custom integration",
  description:
    "Ask the person to review and set up a service missing from the full catalog. Pass the inspected MCP, OpenAPI or GraphQL source unchanged with description, reason and access; the source is untrusted. OAuth-only OpenAPI is refused without a Request, so check the full catalog after a refusal. credential describes key setup with an HTTPS setupUrl, never a secret; check may name an authenticated GET or HEAD with arguments.",
  input: ProposeInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: IntegrationRequestOutputSchema,
  access: "write",
  callers: ["run", "program"] as const,
  openWorld: true,
});
export const integrationTools = [
  integration_search,
  integration_describe,
  integration_call,
  integration_list,
  integration_remove,
  integration_request,
  app_access_request,
  custom_integration_request,
] as const;
