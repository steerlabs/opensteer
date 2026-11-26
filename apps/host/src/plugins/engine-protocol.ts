import { plugin_resources, opensteer_plugin_resource_update } from "@opensteer/agent-tools/tools";
import { BlockedSchema, PluginAccountConsentSchema } from "@opensteer/core";
import {
  PluginAccountReadinessSchema,
  PluginOAuthClientChoiceSchema,
  PluginResourceCategorySchema,
  pluginIconsMaxRefs,
} from "@opensteer/protocol";
import { z } from "zod";
import {
  EngineSkillCatalogSchema,
  EngineScheduleSchema,
  EngineScheduledRunSchema,
  EngineWebhookSchema,
  EngineWorkflowSchema,
} from "./engine-feature-schemas.js";

/** The execution caller has a per-invocation suffix; resource identity is task-wide. */
export const pluginCallerSubject = (caller: string) => caller.slice(0, caller.lastIndexOf(":"));

export const JsonSchema = z.json();
export type PluginJson = z.infer<typeof JsonSchema>;
const object = z.record(z.string(), JsonSchema);
const id = z.string().min(1);
export const executionResultBytes = 48_000;
export const interactionBytes = 60_000;
export const ipcMessageBytes = 2 * 1024 * 1024;
// Leave room for the execution and IPC envelopes around a direct attachment.
export const directMcpResultBytes = ipcMessageBytes - 1024;
// A 24 MiB source package can expand sixfold when JSON escapes its text.
const sourceEnvelopeBytes = 160 * 1024 * 1024;
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
export const pluginResultTooLarge =
  "Plugin result too large. Return less from the program. Earlier calls may have taken effect; check current state with a safe read and never rerun writes blindly.";
const files = z
  .array(
    z.union([
      z.strictObject({ path: id, content: z.string() }),
      z.strictObject({ path: id, content: z.string(), encoding: z.literal("base64") }),
      z.strictObject({ path: id, object: id, size: z.number().int().nonnegative() }),
    ]),
  )
  .max(10_000)
  .refine(
    (entries) =>
      entries.reduce(
        (size, file) =>
          size +
          ("content" in file
            ? Buffer.byteLength(file.content, "encoding" in file ? "base64" : "utf8")
            : file.size),
        0,
      ) <=
      24 * 1024 * 1024,
    "Plugin source exceeds 24 MiB",
  );
export const CallerSchema = z.strictObject({ caller: id, mode: z.enum(["ask", "automatic"]) });
export type PluginCaller = z.infer<typeof CallerSchema>;
/** The engine owner and caller id of the Deployment's one personal owner acting for themselves. */
export const pluginOwnerId = "personal";
export const ConsentSchema = PluginAccountConsentSchema;
export type PluginConsent = z.infer<typeof ConsentSchema>;
const plugin = z.strictObject({ plugin: id });
const target = { plugin: id, requirement: id, scope: z.enum(["app", "user"]) };
const answer = z.strictObject({
  action: z.enum(["accept", "decline", "cancel"]),
  content: object.optional(),
});
// HTTP bodies cross IPC as base64; a response stream is pulled one chunk at a time.
const raw = z.strictObject({
  url: z.string().url(),
  method: id,
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
export const RawResponseSchema = z.strictObject({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  stream: z.string().optional(),
});
export const SourceFilesSchema = files;
export const CatalogEntrySchema = z.object({
  id,
  package: id,
  name: id,
  description: z.string(),
  category: z.string().optional(),
  icons: z.array(object),
  auth: z.array(object),
});
export const CatalogPageInputSchema = z.strictObject({
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const CatalogPageSchema = z.strictObject({
  items: z.array(CatalogEntrySchema),
  cursor: z.string().nullable(),
  /** `unavailable`: the feed could not be read, and the page is empty. */
  feed: z.object({ status: z.enum(["listed", "unavailable", "off"]) }),
});
export const PluginSummarySchema = z.object({
  id,
  name: id,
  slug: id,
  activeVersion: z.string().nullable(),
  page: z.strictObject({ kind: z.literal("plugin"), pluginId: id }).optional(),
});
export const PluginSchema = PluginSummarySchema.extend({
  requirements: z
    .object({
      accounts: z.record(
        z.string(),
        z
          .object({
            scope: z.enum(["app", "user"]),
            provider: id,
            definition: object,
            cardinality: z.enum(["one", "many"]),
          })
          .catchall(JsonSchema),
      ),
    })
    .catchall(JsonSchema),
}).catchall(JsonSchema);
export const AccountSchema = z.object({ id, provider: id, label: z.string() }).catchall(JsonSchema);
export const EngineAccountMetadataSchema = z.object({
  links: z.array(
    z.strictObject({
      requirement: id,
      scope: z.enum(["app", "user"]),
      account: id,
      current: z.boolean(),
    }),
  ),
  readiness: z.record(
    z.string(),
    z.strictObject({
      state: PluginAccountReadinessSchema,
      consent: ConsentSchema.nullable(),
    }),
  ),
});
export type EngineAccountMetadata = z.infer<typeof EngineAccountMetadataSchema>;
export const VersionSchema = z.object({ id }).catchall(JsonSchema);
const toolIndex = z
  .object({
    version: id,
    items: z.array(
      z
        .object({ name: id, description: z.string().optional(), readOnly: z.boolean().optional() })
        .catchall(JsonSchema),
    ),
  })
  .catchall(JsonSchema);
const interaction = z
  .object({
    status: z.enum(["approval-required", "input-required"]),
    requestId: id,
    expiresAt: z.number(),
    elicitation: object,
    invocation: object.optional(),
    tool: object.optional(),
  })
  .catchall(JsonSchema);
const agentResult = z
  .object({
    status: z.string(),
    hostPresentation: z.enum(["blocked", "mcp"]).optional(),
    execution: z
      .object({
        ok: z.boolean(),
        value: JsonSchema.optional(),
        error: object.optional(),
        toolCalls: z.array(object),
      })
      .catchall(JsonSchema)
      .optional(),
  })
  .catchall(JsonSchema);
const executionTarget = z.strictObject({
  plugin: id,
  version: id,
  write: z.boolean(),
  accountSelection: id.optional(),
});
export type PluginExecutionTarget = z.infer<typeof executionTarget>;

export const ExecutionSchema = z.strictObject({
  id,
  caller: id,
  drained: z.literal(true).optional(),
  state: z.enum([
    "running",
    "waiting",
    "answered",
    "completed",
    "cancelled",
    "expired",
    "interrupted",
    "failed",
  ]),
  interaction: interaction
    .refine((value) => jsonBytes(value) <= interactionBytes, "Plugin interaction too large")
    .nullable(),
  result: agentResult
    .refine(
      (value) =>
        jsonBytes(value) <=
        (value.status === "approval-required" || value.status === "input-required"
          ? interactionBytes
          : value.hostPresentation === "mcp"
            ? directMcpResultBytes
            : executionResultBytes),
      "Plugin result too large",
    )
    .optional(),
  reason: z.string().optional(),
  targets: z.array(executionTarget).optional(),
});
export type PluginExecution = z.infer<typeof ExecutionSchema>;
const call = z.strictObject({ path: id, input: JsonSchema });
const search = z.strictObject({
  query: z.string().optional(),
  namespace: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
const execution = z.strictObject({ execution: id });
const management = z.enum([
  "schedules.list",
  "schedules.definitions",
  "schedules.configure",
  "schedules.runNow",
  "schedules.runs",
  "schedules.approval",
  "schedules.answer",
  "workflows.list",
  "workflowRuns.start",
  "workflowRuns.list",
  "workflowRuns.get",
  "workflowRuns.stop",
  "webhooks.remove",
  "webhooks.confirmRemoval",
  "webhookSetup.read",
  "webhookSetup.complete",
]);

const unavailableApp = z.object({
  app: id,
  name: id,
  reason: z.string(),
  router: z.string().optional(),
  blocked: BlockedSchema.optional(),
});

export const operations = {
  health: {
    input: z.strictObject({}),
    output: z.strictObject({ pid: z.number().int(), rss: z.number(), startupMs: z.number() }),
  },
  catalogList: { input: CatalogPageInputSchema, output: CatalogPageSchema },
  catalogDetail: { input: z.strictObject({ id }), output: CatalogEntrySchema },
  /** Images for refs the owner's plugins and the catalog list; a ref with none is left out. */
  icons: {
    input: z.strictObject({ refs: z.array(id).min(1).max(pluginIconsMaxRefs) }),
    output: z.strictObject({
      icons: z.array(z.strictObject({ ref: id, image: z.string() })).max(pluginIconsMaxRefs),
    }),
  },
  list: { input: z.strictObject({}), output: z.array(PluginSummarySchema) },
  installed: {
    input: z.strictObject({
      plugins: z.array(id).min(1).optional(),
      versions: z.boolean().optional(),
    }),
    output: z.array(
      z.strictObject({
        plugin: PluginSchema,
        ...EngineAccountMetadataSchema.shape,
        versions: z.array(VersionSchema).optional(),
        versionCount: z.number().int().optional(),
      }),
    ),
  },
  scheduleApprovals: {
    input: plugin.extend({ cursor: id.optional() }),
    output: z.strictObject({ runs: z.array(EngineScheduledRunSchema), next: id.nullable() }),
  },
  detail: {
    input: plugin,
    output: z.strictObject({
      plugin: PluginSchema,
      tools: toolIndex.nullable(),
      skills: EngineSkillCatalogSchema.nullable(),
      ...EngineAccountMetadataSchema.shape,
      versions: z.array(VersionSchema),
      schedules: z.array(EngineScheduleSchema),
      webhooks: z.array(EngineWebhookSchema),
      workflows: z.array(EngineWorkflowSchema).nullable(),
      hasPage: z.boolean(),
      importWarnings: z.array(z.string().min(1).max(1_000)).optional(),
      toolCount: z.number().int(),
      skillCount: z.number().int(),
      versionCount: z.number().int(),
    }),
  },
  detailSection: {
    input: plugin.extend({
      section: z.enum(["tools", "skills", "versions"]),
      cursor: id.optional(),
    }),
    output: z.object({ items: z.array(object), cursor: z.string().nullable() }),
  },
  install: {
    input: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("files"),
        files,
        plugin: id.optional(),
        name: id.optional(),
        key: id.optional(),
      }),
      z.strictObject({ kind: z.literal("catalog"), id, key: id.optional() }),
      z.strictObject({
        kind: z.enum(["mcp", "openapi", "graphql"]),
        url: z.string().url(),
        name: id,
        key: id.optional(),
      }),
    ]),
    output: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("installed"),
        plugin: PluginSchema,
        version: VersionSchema,
        origin: z.enum(["files", "catalog", "mcp", "openapi", "graphql"]),
        warnings: z.array(z.string().min(1).max(1_000)).optional(),
      }),
      z.strictObject({ status: z.literal("build-error"), error: object }),
    ]),
  },
  export: { input: z.strictObject({ plugin: id, version: id.optional() }), output: files },
  versions: { input: plugin, output: z.array(VersionSchema) },
  activate: { input: z.strictObject({ plugin: id, version: id }), output: JsonSchema },
  remove: { input: plugin, output: JsonSchema },
  accounts: { input: z.strictObject({}), output: z.array(AccountSchema) },
  createApiKeyAccount: {
    input: z.strictObject({
      provider: id,
      method: id,
      fields: object,
      label: z.string().optional(),
      key: id.optional(),
    }),
    output: AccountSchema,
  },
  removeAccount: {
    input: z.strictObject({ account: id }),
    output: z.strictObject({ account: id, affectedPlugins: z.array(id) }),
  },
  reviewAccountLink: { input: z.strictObject(target), output: ConsentSchema },
  linkAccount: {
    input: z.strictObject({ ...target, account: id, consent: ConsentSchema }),
    output: JsonSchema,
  },
  unlinkAccount: { input: z.strictObject({ ...target, account: id }), output: JsonSchema },
  pinOAuth: {
    input: z.strictObject({
      connection: id,
      ownerUserId: id,
      localId: id,
      account: z.strictObject({ issuer: z.url(), subject: id, linkGeneration: id }).nullable(),
    }),
    output: z.null(),
  },
  prepareOAuth: {
    input: z.strictObject({ ...target, key: id.optional() }),
    output: z.strictObject({
      connection: id,
      consent: ConsentSchema,
      callbackProvider: z.enum(["plugin", "mcp"]),
    }),
  },
  oauthMethods: {
    input: z.strictObject({ connection: id, redirectUri: z.url(), linked: z.boolean() }),
    output: z.array(z.strictObject({ method: id, oneClick: z.boolean(), setup: object })),
  },
  startOAuth: {
    input: z.strictObject({
      connection: id,
      consent: ConsentSchema,
      method: id,
      redirectUri: z.url(),
      linked: z.boolean(),
      configurationDigest: id,
      client: PluginOAuthClientChoiceSchema.optional(),
    }),
    output: object,
  },
  completeOAuth: {
    input: z.strictObject({
      connection: id,
      attemptId: id.optional(),
      callbackUrl: z.url().optional(),
    }),
    output: AccountSchema,
  },
  cancelOAuth: { input: z.strictObject({ connection: id }), output: JsonSchema },
  oauthStatus: { input: z.strictObject({ connection: id }), output: object },
  saveOAuthApp: {
    input: z.strictObject({
      issuer: z.url(),
      clientId: id,
      clientSecret: id.optional(),
      key: id.optional(),
    }),
    output: object,
  },
  removeOAuthApp: { input: z.strictObject({ client: id }), output: JsonSchema },
  search: {
    input: search,
    output: z
      .object({
        items: z.array(
          z.strictObject({
            path: id,
            description: z.string(),
            // Absent for a tool the caller is kept from, until it may call it.
            input: z.string().optional(),
            inputTruncated: z.literal(true).optional(),
            blocked: BlockedSchema.optional(),
          }),
        ),
        namespaces: z.array(object),
        remaining: z.number().int(),
        next: search.nullable(),
        unavailableApps: z.array(unavailableApp).optional(),
      })
      .catchall(JsonSchema),
  },
  describe: {
    input: z.strictObject({ paths: z.array(id).min(1).max(100) }),
    output: z.object({
      items: z.array(
        z.strictObject({
          path: id,
          description: z.string(),
          signature: z.string().optional(),
          blocked: BlockedSchema.optional(),
        }),
      ),
      namespaces: z.array(object),
      missing: z.array(z.strictObject({ path: id, matches: z.array(z.string()) })),
      unavailableApps: z.array(unavailableApp).optional(),
    }),
  },
  resolveTools: {
    input: z.strictObject({ paths: z.array(id).min(1).max(100) }),
    output: z.array(
      z
        .strictObject({
          plugin: id,
          name: id,
          version: id,
          readOnly: z.boolean(),
          /** There, but kept from running now: what keeps it, in the Home's words. */
          blocked: BlockedSchema.optional(),
        })
        .nullable(),
    ),
  },
  call: {
    input: z.strictObject({
      calls: z.union([call, z.array(call).min(1)]),
      executionId: id.optional(),
    }),
    output: ExecutionSchema,
  },
  execute: {
    input: z.strictObject({ code: z.string().max(65536), executionId: id.optional() }),
    output: ExecutionSchema,
  },
  resume: { input: execution, output: ExecutionSchema },
  answer: { input: z.strictObject({ execution: id, response: answer }), output: ExecutionSchema },
  cancel: { input: execution, output: ExecutionSchema },
  executions: { input: z.strictObject({}), output: z.array(ExecutionSchema) },
  resultAccess: {
    input: z.strictObject({ targets: z.array(executionTarget) }),
    output: z.boolean(),
  },
  skills: {
    input: z.strictObject({
      app: id.optional(),
      name: id.optional(),
      file: id.optional(),
      version: id.optional(),
      revision: id.optional(),
    }),
    output: JsonSchema,
  },
  skillFiles: {
    input: plugin,
    output: z.strictObject({ plugin: id, slug: id, version: id, hasPage: z.boolean(), files }),
  },
  // The Host supplies caller eligibility. The child also checks current plugin access.
  resourcesRead: {
    input: plugin_resources.input.extend({ outputs: z.boolean() }),
    output: JsonSchema,
  },
  resourcesUpdate: {
    input: opensteer_plugin_resource_update.input.extend({ key: id.optional() }),
    output: JsonSchema,
  },
  manage: { input: z.strictObject({ operation: management, input: object }), output: JsonSchema },
  agentWork: { input: z.strictObject({ stopped: z.boolean() }), output: z.boolean() },
  webhook: {
    input: z.strictObject({ plugin: id, subscription: id, request: raw }),
    output: RawResponseSchema,
  },
  page: { input: z.strictObject({ plugin: id, request: raw }), output: RawResponseSchema },
} as const;
export type PluginOperation = keyof typeof operations;
export type PluginInput<K extends PluginOperation> = z.infer<(typeof operations)[K]["input"]>;
export type PluginOutput<K extends PluginOperation> = z.infer<(typeof operations)[K]["output"]>;
export const pluginComputerStoppedReason = "computer_stopped";
export const pluginComputerStoppedMessage =
  "Agent work is stopped on the computer hosting this Home.";

export const AuthorizationSchema = z.strictObject({
  ...CallerSchema.shape,
  operation: id,
  plugin: id.optional(),
  tool: id.optional(),
  execution: id.optional(),
  write: z.boolean().optional(),
  version: id.optional(),
});
export type PluginAuthorization = z.infer<typeof AuthorizationSchema>;
export const AuthorizationResultSchema = z.strictObject({
  allowed: z.boolean(),
  reason: z.literal("computer_stopped").optional(),
  grants: z.record(z.string(), z.enum(["all", "read-only", "off"])).optional(),
  /** For a connection's selected grant: the only apps it may learn exist. */
  visible: z.array(z.string()).optional(),
  pinnedVersion: id.optional(),
  connected: z.literal(true).optional(),
});
export type PluginAuthorizationResult = z.infer<typeof AuthorizationResultSchema>;
export const HostToolSchema = z.strictObject({
  name: id,
  description: z.string(),
  inputSchema: object,
  outputSchema: object.optional(),
  readOnly: z.boolean().optional(),
});
export const HostProviderSchema = z.strictObject({
  id,
  name: id,
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
  version: id,
  /** Always listed, whatever keeps an agent from calling them now. */
  tools: z.array(HostToolSchema),
  /** Why none of its tools can be called now, said once for all of them. */
  blocked: BlockedSchema.optional(),
  /** Why one tool cannot be called now, where the rest can. */
  toolBlockers: z.record(z.string(), BlockedSchema).optional(),
});
export type PluginHostProvider = z.infer<typeof HostProviderSchema>;
export const BrokerBindingSchema = z.strictObject({
  provider: id,
  revision: z.number().int().positive(),
  redirectUri: z.url(),
  scopes: z.array(id),
  accountLinkGeneration: id,
  requirementDigest: id,
  clientDigest: id,
});
const brokerAttempt = { attemptId: id, binding: BrokerBindingSchema };
const brokerTokens = z.strictObject({
  accessToken: id,
  tokenType: id,
  refreshToken: id.optional(),
  grantedScopes: z.array(id),
  expiresAt: z.number().int().nonnegative().optional(),
});
const brokerResult = z.strictObject({ ...brokerAttempt, tokens: brokerTokens });
export const OAuthConfigurationSchema = z.strictObject({
  clients: z.array(object),
  metadataUrl: z.url().optional(),
  metadataRedirectUri: z.url().optional(),
});
export type PluginOAuthConfiguration = z.infer<typeof OAuthConfigurationSchema>;
export const brokerCallbackOperations = {
  oauthStart: {
    input: z.strictObject({
      connection: id,
      owner: id,
      binding: BrokerBindingSchema.omit({ accountLinkGeneration: true }),
    }),
    output: z.strictObject({
      attemptId: id,
      authorizationUrl: z.url(),
      expiresAt: z.number(),
      accountLinkGeneration: id,
    }),
  },
  oauthPull: { input: z.strictObject(brokerAttempt), output: brokerResult },
  oauthRefresh: {
    input: z.strictObject({
      ...brokerAttempt,
      resultId: id,
      refreshToken: id,
      grantedScopes: z.array(id),
    }),
    output: brokerResult,
  },
  oauthAcknowledge: {
    input: z.strictObject({
      ...brokerAttempt,
      kind: z.enum(["authorization", "refresh"]),
      resultId: id,
    }),
    output: z.null(),
  },
  oauthRevoke: {
    input: z.strictObject({ ...brokerAttempt, tokens: brokerTokens }),
    output: z.null(),
  },
} as const;
export type PluginBrokerOperation = keyof typeof brokerCallbackOperations;
export type PluginBrokerInput<K extends PluginBrokerOperation> = z.infer<
  (typeof brokerCallbackOperations)[K]["input"]
>;
export type PluginBrokerOutput<K extends PluginBrokerOperation> = z.infer<
  (typeof brokerCallbackOperations)[K]["output"]
>;
export const BrokerFailureReasonSchema = z.enum([
  "unavailable",
  "grant_rejected",
  "client_rejected",
  "binding_changed",
  "invalid_response",
]);
export class PluginBrokerError extends Error {
  readonly reason: z.infer<typeof BrokerFailureReasonSchema>;
  constructor(reason: z.infer<typeof BrokerFailureReasonSchema>) {
    super("Account broker operation failed");
    this.reason = reason;
  }
}
export const LocalMcpResultSchema = z.object({
  content: z.array(object),
  structuredContent: object.optional(),
  isError: z.boolean().optional(),
  _meta: object.optional(),
});
export const HostToolResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("value"), value: JsonSchema }),
  z.strictObject({ kind: z.literal("mcp"), result: LocalMcpResultSchema }),
  z.strictObject({ kind: z.literal("blocked"), blocked: BlockedSchema }),
]);
export type HostToolResult = z.infer<typeof HostToolResultSchema>;

export const callbackOperations = {
  ...brokerCallbackOperations,
  oauthConfiguration: {
    input: z.strictObject({ linked: z.boolean() }),
    output: OAuthConfigurationSchema,
  },
  authorize: { input: AuthorizationSchema, output: AuthorizationResultSchema },
  providers: { input: CallerSchema, output: z.array(HostProviderSchema) },
  providerCall: {
    input: z.strictObject({
      ...CallerSchema.shape,
      execution: id,
      plugin: id,
      tool: id,
      input: JsonSchema,
    }),
    output: HostToolResultSchema,
  },
  webhookOrigin: { input: z.strictObject({}), output: z.url().nullable() },
} as const;
export type PluginCallback = keyof typeof callbackOperations;
export const EngineErrorSchema = z.strictObject({
  code: z.enum([
    "unavailable",
    "interrupted",
    "cancelled",
    "forbidden",
    "invalid",
    "consent-changed",
    "engine",
    // A host tool's own failure; its message is written for the agent.
    "tool",
  ]),
  message: z.string(),
  tag: z.string().optional(),
  brokerReason: BrokerFailureReasonSchema.optional(),
});
export class PluginServiceError extends Error {
  readonly code: z.infer<typeof EngineErrorSchema>["code"];
  readonly tag: string | undefined;
  constructor(code: z.infer<typeof EngineErrorSchema>["code"], message: string, tag?: string) {
    super(message);
    this.name = "PluginServiceError";
    this.code = code;
    this.tag = tag;
  }
}
export const EngineInitSchema = z.strictObject({
  databaseUrl: id,
  directory: id,
  owner: id,
  secret: z.string().regex(/^[a-f0-9]{64}$/u),
  origin: z.string().url(),
  bridge: id,
  agentWorkStopped: z.boolean().optional(),
  catalogUrl: z.string().url().optional(),
  npmRegistry: z.string().url().optional(),
  selfOrigin: z.strictObject({ origin: id, address: id }).optional(),
  limits: z.strictObject({
    timeoutMs: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    interactionTtlMs: z.number().int().positive(),
  }),
});
export type EngineInit = z.infer<typeof EngineInitSchema>;
const requestMembers = Object.entries(operations).map(([operation, schemas]) =>
  z.strictObject({
    type: z.literal("request"),
    id,
    operation: z.literal(operation),
    context: CallerSchema,
    input: schemas.input,
  }),
);
const callbackMembers = Object.entries(callbackOperations).map(([operation, schemas]) =>
  z.strictObject({
    type: z.literal("callback"),
    id,
    operation: z.literal(operation),
    input: schemas.input,
  }),
);
const hostMessage = z.union([
  z.strictObject({ type: z.literal("init"), config: EngineInitSchema }),
  z.union(requestMembers),
  z.strictObject({ type: z.literal("cancel"), id }),
  z.strictObject({ type: z.literal("callbackResult"), id, result: JsonSchema }),
  z.strictObject({ type: z.literal("callbackError"), id, error: EngineErrorSchema }),
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({ type: z.literal("streamPull"), id }),
  // A host provider call in flight asks the person a question through the engine's execution.
  z.strictObject({ type: z.literal("elicit"), id, callback: id, request: object }),
  z.strictObject({ type: z.literal("elicitCancel"), id }),
]);
const engineMessage = z.union([
  z.strictObject({
    type: z.literal("resourcesChanged"),
    categories: z.array(PluginResourceCategorySchema).min(1).max(5),
  }),
  z.strictObject({ type: z.literal("diagnostic"), phase: z.string() }),
  z.strictObject({ type: z.literal("ready"), pid: z.number().int(), startupMs: z.number() }),
  z.strictObject({
    type: z.literal("result"),
    id,
    operation: z.enum(Object.keys(operations) as [PluginOperation, ...PluginOperation[]]),
    result: JsonSchema,
  }),
  z.strictObject({ type: z.literal("error"), id, error: EngineErrorSchema }),
  z.strictObject({ type: z.literal("fatal"), error: EngineErrorSchema }),
  z.union(callbackMembers),
  z.strictObject({ type: z.literal("callbackCancel"), id }),
  z.strictObject({
    type: z.literal("streamChunk"),
    id,
    done: z.boolean(),
    chunk: z.string().optional(),
    error: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("execution"), execution: ExecutionSchema }),
  z.strictObject({ type: z.literal("elicitResult"), id, response: answer }),
  z.strictObject({ type: z.literal("elicitError"), id, error: EngineErrorSchema }),
]);
const envelope = z.unknown().superRefine((value, context) => {
  const header = z
    .object({ type: z.string(), operation: z.string().optional() })
    .safeParse(value).data;
  const maximum =
    (header?.type === "result" &&
      (header.operation === "export" || header.operation === "skillFiles")) ||
    (header?.type === "request" && header.operation === "install")
      ? sourceEnvelopeBytes
      : ipcMessageBytes;
  if (jsonBytes(value) > maximum)
    context.addIssue({ code: "custom", message: "Plugin IPC message too large" });
});
export const HostMessageSchema = envelope.pipe(hostMessage);
export const EngineMessageSchema = envelope.pipe(engineMessage);
export function parseIpcMessage<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (
    parsed.error.issues.some(
      (issue) => issue.code === "custom" && issue.message === "Plugin IPC message too large",
    )
  )
    throw new PluginServiceError("tool", pluginResultTooLarge);
  throw parsed.error;
}
export function checkPluginOutputSize(operation: PluginOperation, value: unknown) {
  const maximum =
    operation === "export" || operation === "skillFiles" ? sourceEnvelopeBytes : ipcMessageBytes;
  if (jsonBytes(value) > maximum) throw new PluginServiceError("invalid", pluginResultTooLarge);
}
