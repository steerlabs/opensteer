import { z } from "zod";
import { IsoDateTimeSchema } from "@opensteer/core";

/**
 * The person's side of plugins on a personal Host. Every read and command here
 * is answered by the Host for its owner; a team server exposes none of it.
 * A read sends what its first screen shows and pages the rest by cursor, so a
 * phone on a weak link never waits for a whole list; the catalog is never part
 * of attach.
 */
export const pluginsInstalledPageMax = 50;
export const pluginCatalogPageMax = 50;
export const pluginToolsMax = 500;
export const pluginRunsMax = 50;
export const pluginScheduleApprovalsPageMax = 10;
export const PluginResourceCategorySchema = z.enum([
  "scheduledRuns",
  "workflowRuns",
  "webhooks",
  "webhookSources",
  "schedules",
]);
export type PluginResourceCategory = z.infer<typeof PluginResourceCategorySchema>;
export const PluginChangeSchema = z.object({
  categories: z.array(PluginResourceCategorySchema).min(1).max(5).optional(),
  pluginId: z.string().min(1).optional(),
});
export type PluginChange = z.infer<typeof PluginChangeSchema>;
/** One page of a plugin's tools, skills or versions after the detail's first few. */
export const pluginDetailPageMax = 50;
/** How many tools, skills and versions the detail carries; the rest page. */
export const pluginDetailPreview = { tools: 8, skills: 5, versions: 5 } as const;
/** Icons larger than this are left out of views; a plugin then shows its initial. */
export const pluginIconMaxLength = 8_192;

const text = (max: number) => z.string().max(max);
export const PluginIdSchema = z.string().min(1).max(200);
const name = z.string().min(1).max(240);
const idempotencyKey = z.string().trim().min(1).max(255);
const json = z.json();
const jsonObject = z.record(z.string(), z.json());

export const PluginAccessSchema = z.enum(["all", "read-only", "off"]);
export type PluginAccess = z.infer<typeof PluginAccessSchema>;
export const PluginAuthorSchema = z.enum(["catalog", "agent"]);
export type PluginAuthor = z.infer<typeof PluginAuthorSchema>;
export const PluginScopeSchema = z.enum(["app", "user"]);

/**
 * The plugin engine starts on demand. `idle` costs nothing and starts on the
 * next read; `starting` can take a few seconds on a first open.
 */
export const PluginEngineStatusSchema = z.enum(["idle", "starting", "ready", "unavailable"]);
export type PluginEngineStatus = z.infer<typeof PluginEngineStatusSchema>;
export const PluginEngineStateViewSchema = z.object({
  status: PluginEngineStatusSchema,
  reason: text(500).optional(),
  unavailable: z
    .object({
      code: z.enum(["unsupported-system", "missing-runtime"]),
      minimumMacOS: text(32).optional(),
    })
    .optional(),
});
export type PluginEngineStateView = z.infer<typeof PluginEngineStateViewSchema>;

/** An https URL or a small inline image. */
export const PluginIconSchema = z
  .string()
  .max(pluginIconMaxLength)
  .regex(/^(?:https:\/\/\S+|data:image\/(?:svg\+xml|png|webp|jpeg);base64,[A-Za-z0-9+/]*={0,2})$/u);

/**
 * `needs-account`: a required link is missing or an existing link needs review.
 * `not-built`: no version is active, usually because its build failed.
 */
export const PluginStatusSchema = z.enum(["ready", "needs-account", "not-built"]);
export type PluginStatus = z.infer<typeof PluginStatusSchema>;

export const PluginAccountReadinessSchema = z.enum([
  "required-but-missing",
  "consent-needs-review",
  "usable",
]);

export const PluginSummaryViewSchema = z.object({
  id: PluginIdSchema,
  name,
  slug: name,
  icon: PluginIconSchema.nullable(),
  author: PluginAuthorSchema,
  access: PluginAccessSchema,
  activeVersion: name.nullable(),
  status: PluginStatusSchema,
  accountReadiness: PluginAccountReadinessSchema.optional(),
  /** Account requirements, and how many of them have at least one linked account. */
  accounts: z.object({
    required: z.number().int().nonnegative(),
    linked: z.number().int().nonnegative(),
  }),
});
export type PluginSummaryView = z.infer<typeof PluginSummaryViewSchema>;

export const pluginLocalToolsMax = 100;
/**
 * A device data app or local server agents reach as `tools.<name>` beside plugins, as the
 * installed list shows it: its tools counted, not listed. Its approvals, launch review and
 * secrets stay on the device screens; only agent access is set here.
 */
export const PluginLocalToolSummaryViewSchema = z.object({
  /** `app_device_…` or `app_server_…`; the key `plugins.access.set` takes. */
  id: PluginIdSchema,
  kind: z.enum(["device-app", "local-server"]),
  /** What agents type after `tools.`: the Host's collision-safe name, never derived here. */
  name,
  title: name,
  /** Where it runs; null while a local server has no computer. */
  computer: z.object({ id: name, name }).nullable(),
  /** The Host's sentence when agents can't reach it now. */
  unavailable: text(1_000).nullable(),
  waitingForLaunchApproval: z.literal(true).optional(),
  toolCount: z.number().int().nonnegative(),
  readOnlyToolCount: z.number().int().nonnegative(),
  access: PluginAccessSchema,
});
export type PluginLocalToolSummaryView = z.infer<typeof PluginLocalToolSummaryViewSchema>;
/** One local tool with its tools, for its own page. */
export const PluginLocalToolViewSchema = PluginLocalToolSummaryViewSchema.extend({
  tools: z.array(z.object({ name, readOnly: z.boolean() })).max(pluginToolsMax),
});
export type PluginLocalToolView = z.infer<typeof PluginLocalToolViewSchema>;

const pageCursor = z.string().min(1).max(2_048);
export const PluginsInstalledViewSchema = z.object({
  engine: PluginEngineStateViewSchema,
  /**
   * The first page, those needing the person first. Null until the engine is ready: local tools
   * never wait for it, and `host.plugins-changed` says when to read again.
   */
  plugins: z.array(PluginSummaryViewSchema).max(pluginsInstalledPageMax).nullable(),
  /** `plugins.installed.page` continues from here; null on the last page. */
  cursor: pageCursor.nullable(),
  local: z.array(PluginLocalToolSummaryViewSchema).max(pluginLocalToolsMax),
});
export type PluginsInstalledView = z.infer<typeof PluginsInstalledViewSchema>;

/** What a person agrees to when linking an account to one plugin requirement. */
export const PluginConsentViewSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  /** Sites the credential may be sent to; empty means the plugin did not declare any. */
  sites: z.array(text(2048)).max(100),
  /** `sealed`: plugin code holds a handle only the declared sites can redeem. */
  credential: z.enum(["sealed", "value"]),
});
export type PluginConsentView = z.infer<typeof PluginConsentViewSchema>;
const PluginConsentInputSchema = z.strictObject({
  digest: PluginConsentViewSchema.shape.digest,
  sites: PluginConsentViewSchema.shape.sites,
  credential: PluginConsentViewSchema.shape.credential,
});

export const ConnectedAccountViewSchema = z.object({
  id: name,
  provider: name,
  label: text(240),
});
export type ConnectedAccountView = z.infer<typeof ConnectedAccountViewSchema>;
/** A saved account as Connected accounts lists it: whose it is and every plugin it serves. */
export const PluginAccountViewSchema = ConnectedAccountViewSchema.extend({
  providerName: name,
  links: z.array(z.object({ pluginId: PluginIdSchema, pluginName: name })).max(50),
});
export type PluginAccountView = z.infer<typeof PluginAccountViewSchema>;

export const PluginRequirementViewSchema = z.object({
  readiness: PluginAccountReadinessSchema.optional(),
  name,
  scope: PluginScopeSchema,
  provider: name,
  providerName: name,
  cardinality: z.enum(["one", "many"]),
  /** What linking would agree to now; null while no version is active. */
  consent: PluginConsentViewSchema.nullable(),
  links: z
    .array(
      z.object({
        account: ConnectedAccountViewSchema,
        /** False when the plugin's declaration changed since the person reviewed this link. */
        current: z.boolean(),
      }),
    )
    .max(50),
});
export type PluginRequirementView = z.infer<typeof PluginRequirementViewSchema>;

export const PluginToolViewSchema = z.object({
  name,
  description: text(2_000),
  readOnly: z.boolean(),
});
export type PluginToolView = z.infer<typeof PluginToolViewSchema>;
export const PluginSkillViewSchema = z.object({ name, description: text(2_000) });
export type PluginSkillView = z.infer<typeof PluginSkillViewSchema>;
export const PluginVersionViewSchema = z.object({
  id: name,
  createdAt: IsoDateTimeSchema.nullable(),
  active: z.boolean(),
  author: PluginAuthorSchema,
});
export type PluginVersionView = z.infer<typeof PluginVersionViewSchema>;

export const PluginScheduleTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), milliseconds: z.number().int().positive() }),
  z.object({ kind: z.literal("cron"), expression: text(200), timezone: text(100) }),
]);
export const PluginScheduleViewSchema = z.object({
  name,
  tool: name,
  timing: PluginScheduleTimingSchema,
  /** The person's saved settings; null until they turn it on once. */
  settings: z
    .object({
      id: name,
      enabled: z.boolean(),
      approvalMode: z.enum(["automatic", "browser"]),
      nextAt: IsoDateTimeSchema.nullable(),
      running: z.boolean(),
      /** The requirement it needs an account for; runs are skipped until one is linked. */
      accountRequired: text(240).nullable(),
    })
    .nullable(),
});
export type PluginScheduleView = z.infer<typeof PluginScheduleViewSchema>;

export const PluginWorkflowViewSchema = z.object({
  name,
  description: text(2_000).nullable(),
  /** The JSON Schema of what starting it takes. */
  inputSchema: jsonObject,
});
export type PluginWorkflowView = z.infer<typeof PluginWorkflowViewSchema>;

export const PluginWebhookViewSchema = z.object({
  id: name,
  name,
  status: z.enum(["pending", "setup-required", "active", "stopping", "disabled", "stopped"]),
  failure: z.enum(["register", "unregister"]).nullable(),
  account: name,
  createdAt: IsoDateTimeSchema.nullable(),
});
export type PluginWebhookView = z.infer<typeof PluginWebhookViewSchema>;

export const InstalledPluginViewSchema = z.object({
  plugin: PluginSummaryViewSchema,
  requirements: z.array(PluginRequirementViewSchema).max(50),
  importWarnings: z.array(text(1_000)).optional(),
  /**
   * The first tools by name, null until every required account is linked: a plugin lists its
   * tools with its accounts. `plugins.tools.list` pages all of them.
   */
  tools: z.array(PluginToolViewSchema).max(pluginDetailPreview.tools).nullable(),
  toolCount: z.number().int().nonnegative(),
  /** The first skills by name; `plugins.skills.list` pages all of them. */
  skills: z.array(PluginSkillViewSchema).max(pluginDetailPreview.skills).nullable(),
  skillCount: z.number().int().nonnegative(),
  /** The newest versions; `plugins.versions.list` pages every kept one. */
  versions: z.array(PluginVersionViewSchema).max(pluginDetailPreview.versions),
  versionCount: z.number().int().nonnegative(),
  schedules: z.array(PluginScheduleViewSchema).max(50),
  workflows: z.array(PluginWorkflowViewSchema).max(50).nullable(),
  webhooks: z.array(PluginWebhookViewSchema).max(50),
  /** Why its webhooks can't receive events here, such as no public address. */
  webhookUnavailable: text(500).nullable(),
  /** Why its schedules, webhooks and workflows can't run now. */
  backgroundUnavailable: text(500).nullable(),
  /** The plugin's own page, opened through `plugins.page.view`; null when it has none. */
  page: z
    .object({
      reference: z.object({ kind: z.literal("plugin"), pluginId: PluginIdSchema }),
      /** Why the page cannot be opened from here yet. */
      unavailable: text(500).nullable(),
    })
    .nullable(),
});
export type InstalledPluginView = z.infer<typeof InstalledPluginViewSchema>;

export const PluginCatalogEntryViewSchema = z.object({
  id: name,
  name,
  description: text(1_000),
  icon: PluginIconSchema.nullable(),
  /** How an account is connected: an API key or a sign-in. */
  auth: z
    .array(z.object({ method: name, kind: z.enum(["secrets", "oauth2"]), label: text(240) }))
    .max(8),
});
export type PluginCatalogEntryView = z.infer<typeof PluginCatalogEntryViewSchema>;
export const PluginCatalogPageViewSchema = z.object({
  items: z.array(PluginCatalogEntryViewSchema).max(pluginCatalogPageMax),
  /** Null on the last page. A cursor stops working once the catalog changes. */
  cursor: z.string().max(2_048).nullable(),
  /**
   * Whether the Host could read the catalog. `unavailable`: it can't be reached
   * right now, `items` is empty and asking again later may list it. An older
   * Host omits it.
   */
  catalog: z.enum(["listed", "unavailable"]).optional(),
});
export type PluginCatalogPageView = z.infer<typeof PluginCatalogPageViewSchema>;
export const PluginCatalogPageInputSchema = z.strictObject({
  search: text(200).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(pluginCatalogPageMax).optional(),
});

export const PluginTargetInputSchema = z.strictObject({
  pluginId: PluginIdSchema,
  requirement: name,
  scope: PluginScopeSchema,
});
export type PluginRequirementTarget = z.infer<typeof PluginTargetInputSchema>;

/** One account field an API-key method asks for. */
export const PluginAccountFieldViewSchema = z.object({
  name,
  title: text(240),
  description: text(1_000).nullable(),
  type: z.enum(["string", "number", "integer", "boolean"]),
  choices: z
    .array(z.union([text(240), z.number(), z.boolean()]))
    .max(100)
    .nullable(),
  required: z.boolean(),
  /** Shown as typed; every other field is masked. */
  plain: z.boolean(),
});
export type PluginAccountFieldView = z.infer<typeof PluginAccountFieldViewSchema>;

/** Everything the connect-account screen shows, in one read. */
export const PluginAccountReviewViewSchema = z.object({
  plugin: z.object({ id: PluginIdSchema, name, author: PluginAuthorSchema }),
  requirement: PluginRequirementViewSchema.omit({ consent: true, links: true, readiness: true }),
  consent: PluginConsentViewSchema,
  methods: z
    .array(
      z.object({
        method: name,
        label: text(240),
        fields: z.array(PluginAccountFieldViewSchema).max(32),
      }),
    )
    .max(8),
  /** Whether it can also be connected by signing in at the provider. */
  signIn: z.boolean(),
  /** Saved accounts of this provider the person can link instead. */
  accounts: z.array(ConnectedAccountViewSchema).max(100),
  linked: z.array(name).max(50),
});
export type PluginAccountReviewView = z.infer<typeof PluginAccountReviewViewSchema>;

export const PluginScheduledRunViewSchema = z.object({
  id: name,
  schedule: name,
  status: z.enum([
    "running",
    "awaiting-approval",
    "ready",
    "succeeded",
    "failed",
    "denied",
    "cancelled",
    "expired",
    "interrupted",
  ]),
  scheduledAt: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  failure: text(1_000).nullable(),
  /** The exact call waiting for approval. */
  approval: z.object({ tool: name, arguments: json }).nullable(),
});
export type PluginScheduledRunView = z.infer<typeof PluginScheduledRunViewSchema>;

/**
 * What a run that ended `stale` says, for people and agents: the plugin changed after the work was
 * saved, and what to do about it. A scheduled run never started. A workflow run may have finished
 * earlier steps, which stay done, so the text says to check them first.
 */
export const pluginStaleRunText = {
  schedule:
    "Not run because the plugin changed after this was saved; approve it again when it next asks.",
  workflow:
    "Stopped because the plugin changed after this was started. Steps it had already finished stay done; check them, then start it again.",
} as const;

export const PluginWorkflowRunViewSchema = z.object({
  id: name,
  workflow: name,
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "paused",
    "waitingForPause",
    "complete",
    "errored",
    "terminated",
  ]),
  createdAt: text(64),
  failure: text(1_000).nullable(),
});
export type PluginWorkflowRunView = z.infer<typeof PluginWorkflowRunViewSchema>;

export const PluginWebhookSetupViewSchema = z.object({
  /** Why it can't receive events here, such as no public address. */
  unavailable: text(500).nullable(),
  step: z.enum(["configure", "remove", "done"]),
  webhook: PluginWebhookViewSchema,
  callbackUrl: z.string().max(2_048),
  instructions: text(8_000).nullable(),
  revision: text(200).nullable(),
  stateSchema: jsonObject.nullable(),
  /** A secret Opensteer generated for the person to paste at the provider; shown only during setup. */
  signingSecret: text(1_000).nullable(),
});
export type PluginWebhookSetupView = z.infer<typeof PluginWebhookSetupViewSchema>;

export const pluginReads = {
  "plugins.page.view": {
    input: z.strictObject({ pluginId: PluginIdSchema, theme: z.enum(["light", "dark"]) }),
    output: z.object({ path: z.string().min(1).max(4096), entryUrl: z.url().max(4096).optional() }),
  },
  "plugins.installed.list": { input: z.strictObject({}), output: PluginsInstalledViewSchema },
  "plugins.installed.page": {
    input: z.strictObject({ cursor: pageCursor }),
    output: z.object({
      plugins: z.array(PluginSummaryViewSchema).max(pluginsInstalledPageMax),
      cursor: pageCursor.nullable(),
    }),
  },
  "plugins.local.get": {
    input: z.strictObject({ id: PluginIdSchema }),
    output: PluginLocalToolViewSchema,
  },
  "plugins.get": {
    input: z.strictObject({ pluginId: PluginIdSchema }),
    output: InstalledPluginViewSchema,
  },
  "plugins.tools.list": {
    input: z.strictObject({ pluginId: PluginIdSchema, cursor: pageCursor.optional() }),
    output: z.object({
      tools: z.array(PluginToolViewSchema).max(pluginDetailPageMax),
      cursor: pageCursor.nullable(),
    }),
  },
  "plugins.skills.list": {
    input: z.strictObject({ pluginId: PluginIdSchema, cursor: pageCursor.optional() }),
    output: z.object({
      skills: z.array(PluginSkillViewSchema).max(pluginDetailPageMax),
      cursor: pageCursor.nullable(),
    }),
  },
  "plugins.versions.list": {
    input: z.strictObject({ pluginId: PluginIdSchema, cursor: pageCursor.optional() }),
    output: z.object({
      versions: z.array(PluginVersionViewSchema).max(pluginDetailPageMax),
      cursor: pageCursor.nullable(),
    }),
  },
  "plugins.catalog.list": {
    input: PluginCatalogPageInputSchema,
    output: PluginCatalogPageViewSchema,
  },
  "plugins.catalog.get": {
    input: z.strictObject({ catalogId: name }),
    output: PluginCatalogEntryViewSchema,
  },
  "plugins.accounts.list": {
    input: z.strictObject({}),
    output: z.object({ accounts: z.array(PluginAccountViewSchema).max(500) }),
  },
  "plugins.account.review": {
    input: PluginTargetInputSchema,
    output: PluginAccountReviewViewSchema,
  },
  "plugins.schedule.runs": {
    input: z.strictObject({
      pluginId: PluginIdSchema,
      pending: z.boolean().optional(),
      cursor: pageCursor.optional(),
    }),
    output: z.object({
      pending: z.array(PluginScheduledRunViewSchema).max(pluginScheduleApprovalsPageMax).optional(),
      cursor: pageCursor.nullable().optional(),
      runs: z.array(PluginScheduledRunViewSchema).max(pluginRunsMax),
    }),
  },
  "plugins.workflow.runs": {
    input: z.strictObject({
      pluginId: PluginIdSchema,
      workflow: name.optional(),
      runIds: z.array(name).min(1).max(pluginRunsMax).optional(),
      cursor: z.string().min(1).max(512).optional(),
    }),
    output: z.object({
      runs: z.array(PluginWorkflowRunViewSchema).max(pluginRunsMax),
      cursor: z.string().max(512).nullable(),
    }),
  },
  "plugins.webhook.setup.get": {
    input: z.strictObject({ pluginId: PluginIdSchema, webhookId: name }),
    output: PluginWebhookSetupViewSchema,
  },
} as const;

const pluginInstallSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("catalog"), catalogId: name }),
  z.strictObject({
    kind: z.enum(["mcp", "openapi", "graphql"]),
    url: z.url({ protocol: /^https?$/u }).max(2_048),
    name: z.string().trim().min(1).max(120),
  }),
]);
const accountFieldValue = z.union([z.string().max(16_384), z.number(), z.boolean()]);

export const PluginCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("plugins.install"),
    idempotencyKey,
    source: pluginInstallSourceSchema,
  }),
  z.strictObject({
    type: z.literal("plugins.version.activate"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    versionId: name,
  }),
  z.strictObject({ type: z.literal("plugins.remove"), idempotencyKey, pluginId: PluginIdSchema }),
  z.strictObject({
    type: z.literal("plugins.access.set"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    access: PluginAccessSchema,
  }),
  /** Saves an API key as a connected account and, with `link`, links it as reviewed. */
  z.strictObject({
    type: z.literal("plugins.account.create"),
    idempotencyKey,
    provider: name,
    method: name,
    fields: z.record(z.string().min(1).max(240), accountFieldValue),
    label: z.string().trim().min(1).max(120).optional(),
    link: PluginTargetInputSchema.extend({ consent: PluginConsentInputSchema }).optional(),
  }),
  z.strictObject({ type: z.literal("plugins.account.remove"), idempotencyKey, accountId: name }),
  z.strictObject({
    type: z.literal("plugins.account.link"),
    idempotencyKey,
    ...PluginTargetInputSchema.shape,
    accountId: name,
    consent: PluginConsentInputSchema,
  }),
  z.strictObject({
    type: z.literal("plugins.account.unlink"),
    idempotencyKey,
    ...PluginTargetInputSchema.shape,
    accountId: name,
  }),
  z.strictObject({
    type: z.literal("plugins.schedule.configure"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    schedule: name,
    enabled: z.boolean(),
    approvalMode: z.enum(["automatic", "browser"]).optional(),
  }),
  z.strictObject({
    type: z.literal("plugins.schedule.answer"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    runId: name,
    action: z.enum(["accept", "decline"]),
  }),
  z.strictObject({
    type: z.literal("plugins.workflow.start"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    workflow: name,
    input: json,
  }),
  z.strictObject({
    type: z.literal("plugins.workflow.stop"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    runId: name,
  }),
  z.strictObject({
    type: z.literal("plugins.webhook.remove"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    webhookId: name,
  }),
  z.strictObject({
    type: z.literal("plugins.webhook.removal.confirm"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    webhookId: name,
  }),
  z.strictObject({
    type: z.literal("plugins.webhook.setup.complete"),
    idempotencyKey,
    pluginId: PluginIdSchema,
    webhookId: name,
    revision: name,
    state: json,
    secret: z.string().min(1).max(4_096).optional(),
  }),
]);
export type PluginCommand = z.infer<typeof PluginCommandSchema>;

export const PluginCommandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plugins.install"),
    result: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("installed"),
        pluginId: PluginIdSchema,
        versionId: name,
        warnings: z.array(text(1_000)).optional(),
      }),
      /** No version became active; the message says what to fix. */
      z.object({ status: z.literal("build-error"), message: text(4_000) }),
    ]),
  }),
  z.object({ type: z.literal("plugins.version.activate") }),
  z.object({ type: z.literal("plugins.remove") }),
  z.object({ type: z.literal("plugins.access.set"), access: PluginAccessSchema }),
  z.object({ type: z.literal("plugins.account.create"), account: ConnectedAccountViewSchema }),
  z.object({ type: z.literal("plugins.account.remove") }),
  z.object({ type: z.literal("plugins.account.link") }),
  z.object({ type: z.literal("plugins.account.unlink") }),
  z.object({ type: z.literal("plugins.schedule.configure") }),
  z.object({ type: z.literal("plugins.schedule.answer") }),
  z.object({ type: z.literal("plugins.workflow.start"), runId: name }),
  z.object({ type: z.literal("plugins.workflow.stop") }),
  z.object({ type: z.literal("plugins.webhook.setup.complete") }),
  z.object({ type: z.literal("plugins.webhook.remove") }),
  z.object({ type: z.literal("plugins.webhook.removal.confirm") }),
]);
export type PluginCommandResult = z.infer<typeof PluginCommandResultSchema>;
