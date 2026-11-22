import { requestDecision } from "../host/client.js";
import cronstrue from "cronstrue";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { Request, RequestResponse } from "@opensteer/core";
import type {
  InstalledPluginView,
  PluginAccess,
  PluginAccountFieldView,
  PluginAccountReviewView,
  PluginAuthor,
  PluginCatalogEntryView,
  PluginChange,
  PluginResourceCategory,
  PluginCommand,
  PluginCommandResult,
  PluginConsentView,
  PluginEngineStateView,
  PluginLocalToolSummaryView,
  PluginLocalToolView,
  PluginRequirementTarget,
  PluginScheduleView,
  PluginScheduledRunView,
  PluginSkillView,
  PluginSummaryView,
  PluginToolView,
  PluginVersionView,
  PluginWorkflowRunView,
} from "@opensteer/protocol";
import { pluginStaleRunText } from "@opensteer/protocol";
import { isHostRefusal, type HostClient } from "../host/client.js";
import { clientScopeKey } from "../connections/connection-controller.js";
import { ClientOperationError } from "../connections/operation-error.js";
import { presentClientIssue, type ClientIssue } from "../feedback/client-issue.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "../host/host-session-client.js";
import type { KeysetPage } from "../reads/paged-list.js";
import { pluginInputForm, type PluginInputForm } from "./input-form.js";

export type {
  ConnectedAccountView,
  InstalledPluginView,
  PluginAccess,
  PluginAccountReviewView,
  PluginCatalogEntryView,
  PluginEngineStateView,
  PluginRequirementTarget,
  PluginSummaryView,
} from "@opensteer/protocol";

export type PluginsHost = Pick<HostClient, "rpc" | "dispatch">;

export * from "./sign-in.js";

/* ---- Reads ---- */

/** The first screen of Plugins: a page of plugins, and the local tools beside them. */
export function readInstalledPlugins(client: PluginsHost) {
  return client.rpc["plugins.installed.list"]({}).then(unwrapRpcResult);
}
/**
 * The installed plugins after the first page, for a paged list: `null` reads
 * from `after`, the cursor the first page ended with.
 */
export function pluginInstalledReader(
  client: PluginsHost,
  after: string,
): (cursor: string | null) => Promise<KeysetPage<PluginSummaryView>> {
  return async (cursor) => {
    const page = await client.rpc["plugins.installed.page"]({ cursor: cursor ?? after }).then(
      unwrapRpcResult,
    );
    return { items: page.plugins, nextCursor: page.cursor };
  };
}
/** One local tool with its tools, for its own page. */
export function readPluginLocalTool(client: PluginsHost, id: string) {
  return client.rpc["plugins.local.get"]({ id }).then(unwrapRpcResult);
}
export function readPlugin(client: PluginsHost, pluginId: string) {
  return client.rpc["plugins.get"]({ pluginId }).then(unwrapRpcResult);
}
/** All of a plugin's tools, skills or versions, a page at a time, past the detail's first few. */
export function pluginToolsReader(client: PluginsHost, pluginId: string) {
  return async (cursor: string | null): Promise<KeysetPage<PluginToolView>> => {
    const page = await client.rpc["plugins.tools.list"]({
      pluginId,
      ...(cursor ? { cursor } : {}),
    }).then(unwrapRpcResult);
    return { items: page.tools, nextCursor: page.cursor };
  };
}
export function pluginSkillsReader(client: PluginsHost, pluginId: string) {
  return async (cursor: string | null): Promise<KeysetPage<PluginSkillView>> => {
    const page = await client.rpc["plugins.skills.list"]({
      pluginId,
      ...(cursor ? { cursor } : {}),
    }).then(unwrapRpcResult);
    return { items: page.skills, nextCursor: page.cursor };
  };
}
export function pluginVersionsReader(client: PluginsHost, pluginId: string) {
  return async (cursor: string | null): Promise<KeysetPage<PluginVersionView>> => {
    const page = await client.rpc["plugins.versions.list"]({
      pluginId,
      ...(cursor ? { cursor } : {}),
    }).then(unwrapRpcResult);
    return { items: page.versions, nextCursor: page.cursor };
  };
}
export function readPluginAccountReview(client: PluginsHost, target: PluginRequirementTarget) {
  return client.rpc["plugins.account.review"](target).then(unwrapRpcResult);
}
export function readPluginScheduleRuns(client: PluginsHost, pluginId: string, cursor?: string) {
  return client.rpc["plugins.schedule.runs"]({ pluginId, ...(cursor ? { cursor } : {}) }).then(
    unwrapRpcResult,
  );
}
export function readPluginWorkflowRuns(
  client: PluginsHost,
  pluginId: string,
  cursor?: string,
  runIds?: readonly string[],
) {
  return client.rpc["plugins.workflow.runs"]({
    pluginId,
    ...(cursor ? { cursor } : {}),
    ...(runIds ? { runIds: [...runIds] } : {}),
  }).then(unwrapRpcResult);
}

export function pluginChangeAffects(
  change: PluginChange,
  categories: readonly PluginResourceCategory[] = [],
  pluginId?: string,
) {
  if (pluginId && change.pluginId && change.pluginId !== pluginId) return false;
  return !change.categories || change.categories.some((category) => categories.includes(category));
}
export function readPluginWebhookSetup(client: PluginsHost, pluginId: string, webhookId: string) {
  return client.rpc["plugins.webhook.setup.get"]({ pluginId, webhookId }).then(unwrapRpcResult);
}

export const pluginCatalogPageSize = 30;
/**
 * The catalog read page by page for one search. The Host pages it; a blank
 * search lists everything in the catalog's own order. A catalog the Host
 * can't reach fails the read with `pluginCatalogUnavailable`, so it is never
 * shown as an empty catalog.
 */
export function pluginCatalogReader(
  client: PluginsHost,
  search: string,
): (cursor: string | null) => Promise<KeysetPage<PluginCatalogEntryView>> {
  const text = search.trim();
  return async (cursor) => {
    const page = await client.rpc["plugins.catalog.list"]({
      limit: pluginCatalogPageSize,
      ...(text ? { search: text } : {}),
      ...(cursor ? { cursor } : {}),
    }).then(unwrapRpcResult);
    if (page.catalog === "unavailable")
      throw new ClientOperationError("The plugin catalog can't be reached.", "blocked", {
        kind: "service",
        provenance: "host",
        code: "unavailable",
        reason: pluginCatalogUnavailable,
        retryable: false,
      });
    return { items: page.items, nextCursor: page.cursor };
  };
}

/** The reason a catalog read failed because the Host can't reach the catalog. */
export const pluginCatalogUnavailable = "plugin-catalog-unavailable";

/**
 * What the catalog list shows, the same on every screen: loading, a failed
 * read with nothing to show (with Try again when trying again can help), an
 * empty result, or the entries, with a line when a later read failed and the
 * entries shown are the ones already loaded.
 */
export type PluginCatalogListView =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly text: string; readonly retry: boolean }
  | { readonly kind: "empty"; readonly text: string | null }
  | {
      readonly kind: "entries";
      readonly issue: { readonly text: string; readonly retry: boolean } | null;
    };
/** `deviceApps` counts the device apps listed beside the plugins: while one shows, nothing is unmatched. */
export function pluginCatalogListView(
  list: {
    readonly loading: boolean;
    readonly items: readonly unknown[];
    readonly error: ClientIssue | null;
  },
  search: string,
  deviceApps = 0,
): PluginCatalogListView {
  if (list.loading) return { kind: "loading" };
  const issue = list.error
    ? (() => {
        const presented = presentClientIssue({ ...list.error, resource: "the catalog" });
        return { text: presented.title, retry: presented.action === "retry" };
      })()
    : null;
  if (list.items.length) return { kind: "entries", issue };
  if (issue) return { kind: "failed", ...issue };
  return {
    kind: "empty",
    text: deviceApps
      ? null
      : search
        ? `Nothing in the catalog matches “${search}”.`
        : "The catalog is empty.",
  };
}

/* ---- Commands ---- */

type CommandInput<T extends PluginCommand["type"]> = Omit<
  Extract<PluginCommand, { type: T }>,
  "type" | "idempotencyKey"
>;
async function command<T extends PluginCommand["type"]>(
  client: PluginsHost,
  type: T,
  input: CommandInput<T>,
  idempotencyKey = mutationIdempotencyKey(type),
): Promise<Extract<PluginCommandResult, { type: T }>> {
  const result = await client.dispatch({
    ...input,
    type,
    idempotencyKey,
  } as Extract<PluginCommand, { type: T }>);
  if (result.type !== type) throw new Error(`The Host answered ${result.type} to ${type}.`);
  return result as Extract<PluginCommandResult, { type: T }>;
}

export const installPlugin = (
  client: PluginsHost,
  source: CommandInput<"plugins.install">["source"],
) => command(client, "plugins.install", { source }).then(({ result }) => result);
export const activatePluginVersion = (client: PluginsHost, pluginId: string, versionId: string) =>
  command(client, "plugins.version.activate", { pluginId, versionId });
export const removePlugin = (client: PluginsHost, pluginId: string) =>
  command(client, "plugins.remove", { pluginId });
export const setPluginAccess = (client: PluginsHost, pluginId: string, access: PluginAccess) =>
  command(client, "plugins.access.set", { pluginId, access });
export const createPluginAccount = (
  client: PluginsHost,
  input: CommandInput<"plugins.account.create">,
  idempotencyKey?: string,
) =>
  command(client, "plugins.account.create", input, idempotencyKey).then(({ account }) => account);

/** An unchanged key submission can recover its receipt after a lost answer. */
export function createPluginAccountAttempt(client: PluginsHost & Pick<HostClient, "connection">) {
  type Input = CommandInput<"plugins.account.create">;
  let uncertain: {
    readonly scope: string | null;
    readonly input: Input;
    readonly key: string;
  } | null = null;
  return async (input: Input) => {
    const scope = clientScopeKey(client.connection.getSnapshot().scope);
    const attempt =
      uncertain?.scope === scope && canonicalJson(uncertain.input) === canonicalJson(input)
        ? uncertain
        : { scope, input, key: mutationIdempotencyKey("plugins.account.create") };
    uncertain = attempt;
    try {
      const account = await createPluginAccount(client, attempt.input, attempt.key);
      if (uncertain === attempt) uncertain = null;
      return account;
    } catch (error) {
      if (uncertain === attempt && isHostRefusal(error)) uncertain = null;
      throw error;
    }
  };
}
export const removePluginAccount = (client: PluginsHost, accountId: string) =>
  command(client, "plugins.account.remove", { accountId });
export const linkPluginAccount = (
  client: PluginsHost,
  target: PluginRequirementTarget,
  accountId: string,
  consent: PluginConsentView,
) =>
  command(client, "plugins.account.link", {
    ...target,
    accountId,
    consent: { digest: consent.digest, sites: consent.sites, credential: consent.credential },
  });
export const unlinkPluginAccount = (
  client: PluginsHost,
  target: PluginRequirementTarget,
  accountId: string,
) => command(client, "plugins.account.unlink", { ...target, accountId });
export const configurePluginSchedule = (
  client: PluginsHost,
  input: CommandInput<"plugins.schedule.configure">,
) => command(client, "plugins.schedule.configure", input);
export const answerPluginScheduledRun = (
  client: PluginsHost,
  pluginId: string,
  runId: string,
  action: "accept" | "decline",
) => command(client, "plugins.schedule.answer", { pluginId, runId, action });
export const startPluginWorkflow = (
  client: PluginsHost,
  pluginId: string,
  workflow: string,
  input: CommandInput<"plugins.workflow.start">["input"],
) => command(client, "plugins.workflow.start", { pluginId, workflow, input });
export const stopPluginWorkflow = (client: PluginsHost, pluginId: string, runId: string) =>
  command(client, "plugins.workflow.stop", { pluginId, runId });
export const completePluginWebhookSetup = (
  client: PluginsHost,
  input: CommandInput<"plugins.webhook.setup.complete">,
) => command(client, "plugins.webhook.setup.complete", input);

export const removePluginWebhook = (client: PluginsHost, pluginId: string, webhookId: string) =>
  command(client, "plugins.webhook.remove", { pluginId, webhookId });
export const confirmPluginWebhookRemoval = (
  client: PluginsHost,
  pluginId: string,
  webhookId: string,
) => command(client, "plugins.webhook.removal.confirm", { pluginId, webhookId });

/** Answers one of the three plugin Requests through the ordinary Request path. */
export function respondToPluginRequest(
  client: PluginsHost,
  request: Request,
  response: RequestResponse,
) {
  return client.dispatch({
    type: "request.respond",
    idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
    ...requestDecision(request),
    response,
  });
}

/* ---- How a plugin reads ---- */

export type PluginTone = "ok" | "attention" | "muted" | "error";

/** One plugin's state as a short label, from what the Host reported. */
export function pluginStatusView(plugin: PluginSummaryView): {
  readonly label: string;
  readonly tone: PluginTone;
} {
  if (plugin.status === "not-built") return { label: "Didn't build", tone: "error" };
  if (plugin.status === "needs-account" && plugin.accountReadiness === "consent-needs-review")
    return { label: "Review account access", tone: "attention" };
  if (plugin.status === "needs-account") return { label: "Connect an account", tone: "attention" };
  if (plugin.access === "off") return { label: "Off for agents", tone: "muted" };
  if (plugin.access === "read-only") return { label: "Read-only", tone: "ok" };
  return { label: "On", tone: "ok" };
}

/**
 * What the engine's state means to someone waiting on it; null when nothing
 * needs saying. `detail` keeps the Host's own reason, for whoever needs it.
 */
export function pluginEngineNotice(engine: PluginEngineStateView | null): {
  readonly tone: "progress" | "error";
  readonly text: string;
  readonly detail: string | null;
} | null {
  if (!engine) return null;
  if (engine.status === "starting")
    return {
      tone: "progress",
      text: "Starting plugins. The first open can take a few seconds.",
      detail: null,
    };
  if (engine.status === "unavailable")
    return {
      tone: "error",
      text: pluginUnavailableText(engine.unavailable),
      detail: engine.reason ?? null,
    };
  return null;
}

/** What a person can do about why the Host says the plugin sandbox can't run. */
function pluginUnavailableText(unavailable: PluginEngineStateView["unavailable"]) {
  if (unavailable?.code === "missing-runtime")
    return "Plugins aren't installed correctly on this computer. Reinstalling Opensteer should fix it.";
  if (unavailable?.code === "unsupported-system")
    return unavailable.minimumMacOS
      ? `Plugins need macOS ${unavailable.minimumMacOS} or later. Update macOS on this computer to use them.`
      : "Plugins aren't supported on this computer.";
  return "Plugins aren't working on this computer right now.";
}

/** A refused read that means the engine is unavailable, as the state to show instead of an error. */
export function pluginEngineRefusal(error: unknown): PluginEngineStateView | null {
  return typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "plugin-engine-unavailable"
    ? {
        status: "unavailable",
        ...("message" in error && typeof error.message === "string"
          ? { reason: error.message }
          : {}),
      }
    : null;
}

export const pluginAccessChoices: readonly {
  readonly value: PluginAccess;
  readonly label: string;
  readonly detail: string;
}[] = [
  { value: "all", label: "All tools", detail: "Agents can use every tool this plugin has." },
  {
    value: "read-only",
    label: "Read-only",
    detail: "Only tools the plugin marks as reading. Unmarked tools count as writing.",
  },
  { value: "off", label: "Off", detail: "Agents can't see or use this plugin." },
];

export function pluginAuthorText(author: PluginAuthor) {
  return author === "catalog" ? "From the plugin catalog" : "Written by an agent";
}

/**
 * The consent a person gives by linking an account, in the order it matters:
 * where the credential may go, what the plugin's code receives, the trust
 * linking places in that code, and who wrote it. "This plugin's code" rather
 * than the plugin's name, which is often the service's: it is not the
 * service's code.
 */
export function pluginConsentLines(input: {
  readonly consent: PluginConsentView;
  readonly author: PluginAuthor;
  readonly pluginName: string;
  /** Null where only the requirement is known, as on a Request card. */
  readonly providerName: string | null;
}): readonly { readonly key: string; readonly text: string }[] {
  const { consent } = input;
  const sites = consent.sites.map((site) => site.replace(/^https?:\/\//u, ""));
  const credential = input.providerName
    ? `your ${input.providerName} credential`
    : "the credential";
  const Credential = `${credential[0]!.toUpperCase()}${credential.slice(1)}`;
  const sealed = consent.credential === "sealed";
  return [
    {
      key: "sites",
      // Plugin code that receives the credential itself can send it anywhere,
      // whatever sites it declares; only a sealed credential is confined to them.
      text: sealed
        ? sites.length
          ? `${Credential} can only be sent to ${listText(sites)}.`
          : `This plugin doesn't say which sites ${credential} may go to.`
        : sites.length
          ? `This plugin says it uses ${credential} with ${listText(sites)}, but its code can send it elsewhere.`
          : `This plugin doesn't say which sites it sends ${credential} to.`,
    },
    {
      key: "credential",
      text: sealed
        ? `This plugin's code never sees ${credential}. It gets an account reference that only works for ${sites.length ? "those sites" : "the sites it declares"}.`
        : `This plugin's code receives ${credential} itself and could send it to any site.`,
    },
    {
      key: "trust",
      text: "Linking trusts this plugin's code with this account. Its setup runs with the account before any tool asks for approval.",
    },
    {
      key: "author",
      text:
        input.author === "catalog"
          ? `The ${input.pluginName} plugin comes from the plugin catalog.`
          : `The ${input.pluginName} plugin was written by an agent. Nobody else reviewed its code.`,
    },
  ];
}
function listText(items: readonly string[]) {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/* ---- API-key account form ---- */

/** The values to send for one method's fields; blank optional fields are left out. */
export function pluginAccountValues(
  fields: readonly PluginAccountFieldView[],
  values: Readonly<Record<string, string>>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const value = values[field.name] ?? "";
    if (value === "" && !field.required) continue;
    result[field.name] =
      field.type === "boolean" ? value === "true" : field.type === "string" ? value : Number(value);
  }
  return result;
}
export function pluginAccountComplete(
  fields: readonly PluginAccountFieldView[],
  values: Readonly<Record<string, string>>,
) {
  return fields.every((field) => {
    const value = values[field.name] ?? "";
    if (value === "") return !field.required;
    return field.type === "number" || field.type === "integer"
      ? Number.isFinite(Number(value)) &&
          (field.type === "number" || Number.isInteger(Number(value)))
      : true;
  });
}
/** Saved accounts the person can link instead of entering a new one; linked ones first. */
export function pluginLinkableAccounts(review: PluginAccountReviewView) {
  const linked = new Set(review.linked);
  return [...review.accounts]
    .map((account) => ({ ...account, linked: linked.has(account.id) }))
    .sort((a, b) => Number(b.linked) - Number(a.linked) || a.label.localeCompare(b.label));
}

export * from "./input-form.js";
export * from "./webhooks.js";
export * from "./accounts.js";
export * from "./runs.js";
/* ---- The three plugin Requests ---- */

type PluginPresentation = NonNullable<Request["presentation"]["plugin"]>;
export type PluginRequestView =
  | {
      readonly kind: "account";
      readonly plugin: PluginPresentation["plugin"];
      readonly target: PluginRequirementTarget;
      readonly consent: PluginConsentView;
    }
  | {
      readonly kind: "approval";
      readonly plugin: PluginPresentation["plugin"];
      readonly tool: string;
      /** The exact arguments the call runs with, formatted for reading. */
      readonly argumentsText: string;
    }
  | {
      readonly kind: "input";
      readonly plugin: PluginPresentation["plugin"];
      readonly tool: string;
      readonly form: PluginInputForm;
    };

export function isPluginRequest(request: Pick<Request, "kind">) {
  return (
    request.kind === "plugin.account" ||
    request.kind === "plugin.approval" ||
    request.kind === "plugin.input"
  );
}

/** What a plugin Request asks, from the presentation the Host stored; null for any other. */
export function pluginRequestView(
  request: Pick<Request, "kind" | "presentation">,
): PluginRequestView | null {
  const context = request.presentation.plugin;
  if (!context || !isPluginRequest(request)) return null;
  const decision = context.decision;
  if (request.kind === "plugin.account" && decision.kind === "account")
    return {
      kind: "account",
      plugin: context.plugin,
      target: {
        pluginId: context.plugin.id,
        requirement: decision.requirement,
        scope: decision.scope,
      },
      consent: decision.consent,
    };
  if (request.kind === "plugin.approval" && decision.kind === "approval")
    return {
      kind: "approval",
      plugin: context.plugin,
      tool: decision.tool,
      argumentsText: JSON.stringify(decision.arguments, null, 2) ?? "null",
    };
  if (request.kind === "plugin.input" && decision.kind === "input")
    return {
      kind: "input",
      plugin: context.plugin,
      tool: decision.tool,
      form: pluginInputForm(decision.schema),
    };
  return null;
}

/** Replies for each plugin Request, in the shapes the Host accepts. */
export const pluginRequestResponses = {
  accountDeclined: { kind: "external", value: { decision: "declined" } },
  approve: { kind: "choice", optionId: "accept" },
  decline: { kind: "choice", optionId: "decline" },
  inputDeclined: { kind: "external", value: { action: "decline" } },
  input: (content: Record<string, unknown>): RequestResponse => ({
    kind: "external",
    value: { action: "accept", content: JSON.parse(JSON.stringify(content)) },
  }),
} as const satisfies Record<
  string,
  RequestResponse | ((content: Record<string, unknown>) => RequestResponse)
>;

/* ---- Schedules, workflows, catalog ---- */

export function pluginScheduleText(timing: PluginScheduleView["timing"]) {
  if (timing.kind === "cron") {
    try {
      return `${cronstrue.toString(timing.expression, { verbose: false })} (${timing.timezone})`;
    } catch {
      return `${timing.expression} (${timing.timezone})`;
    }
  }
  const minutes = Math.round(timing.milliseconds / 60_000);
  if (minutes < 60) return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  return `Every ${minutes} minutes`;
}

/** Why an enabled schedule's runs are being skipped, from what the Host reports; null when not. */
export function pluginScheduleSkipped(
  schedule: PluginScheduleView,
  requirements: InstalledPluginView["requirements"],
): string | null {
  const needed = schedule.settings?.enabled ? schedule.settings.accountRequired : null;
  if (!needed) return null;
  const provider = requirements.find(({ name }) => name === needed)?.providerName ?? needed;
  return `Skipped until you connect a ${provider} account`;
}

/** Whether to say why background work can't run: only for a plugin that has some. */
export function pluginBackgroundNotice(data: InstalledPluginView): string | null {
  const background =
    data.schedules.length > 0 || data.webhooks.length > 0 || (data.workflows?.length ?? 0) > 0;
  return background ? data.backgroundUnavailable : null;
}

export function pluginScheduledRunLabel(run: PluginScheduledRunView) {
  switch (run.status) {
    case "awaiting-approval":
      return "Waiting for your approval";
    case "ready":
    case "running":
      return "Running";
    case "succeeded":
      return "Done";
    case "failed":
      if (run.failure === "stale") return pluginStaleRunText.schedule;
      return run.failure ? `Failed: ${run.failure}` : "Failed";
    case "denied":
      return "Declined";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired before approval";
    case "interrupted":
      return "Interrupted";
  }
}
export function pluginWorkflowRunLabel(run: PluginWorkflowRunView) {
  switch (run.status) {
    case "queued":
      return "Queued";
    case "complete":
      return "Done";
    case "errored":
      if (run.failure === "stale") return pluginStaleRunText.workflow;
      return run.failure ? `Failed: ${run.failure}` : "Failed";
    case "terminated":
      return "Stopped";
    case "paused":
    case "waitingForPause":
      return "Paused";
    default:
      return "Running";
  }
}

/** Catalog entries already installed, matched by name: a hint only, the Host decides. */
export function pluginCatalogInstalled(
  entry: Pick<PluginCatalogEntryView, "name">,
  installed: readonly Pick<PluginSummaryView, "name">[],
) {
  const name = entry.name.toLocaleLowerCase();
  return installed.some((plugin) => plugin.name.toLocaleLowerCase() === name);
}

/** Groups the installed list the way it reads: what needs the person first. */
export function pluginInstalledGroups(plugins: readonly PluginSummaryView[]) {
  const attention = plugins.filter((plugin) => plugin.status !== "ready");
  const ready = plugins.filter((plugin) => plugin.status === "ready");
  return [
    { id: "attention", title: "Needs you", plugins: attention },
    { id: "installed", title: "Installed", plugins: ready },
  ].filter((group) => group.plugins.length > 0);
}

/** What the requirement needs before its tools can run; null when it is satisfied. */
export function pluginRequirementIssue(
  requirement: InstalledPluginView["requirements"][number],
): string | null {
  if (requirement.readiness === "consent-needs-review")
    return "This plugin changed what it asks for. Review the account again.";
  if (requirement.readiness === "required-but-missing")
    return `Connect a ${requirement.providerName} account to use this plugin.`;
  return null;
}

export function pluginEmptyToolsText(data: {
  plugin: Pick<PluginSummaryView, "access" | "status">;
  tools: InstalledPluginView["tools"];
}) {
  if (data.plugin.access === "off") return "Tools are off for agents.";
  if (data.tools === null)
    return data.plugin.status === "not-built"
      ? "Tools appear once a version builds."
      : "Tools appear once its accounts are connected.";
  return data.tools.length === 0 ? "This plugin has no tools." : null;
}

/* ---- Device data apps and local servers beside plugins ---- */

export type { PluginLocalToolSummaryView, PluginLocalToolView } from "@opensteer/protocol";

/** A local tool's state as a short label: why agents can't reach it first. */
export function pluginLocalToolStatus(tool: PluginLocalToolSummaryView): {
  readonly label: string;
  readonly tone: PluginTone;
} {
  if (tool.access === "off") return { label: "Off for agents", tone: "muted" };
  if (tool.waitingForLaunchApproval) return { label: "Waiting for approval", tone: "attention" };
  if (tool.unavailable) return { label: tool.unavailable, tone: "attention" };
  if (tool.access === "read-only") return { label: "Read-only", tone: "ok" };
  return { label: "On", tone: "ok" };
}

/** What a local tool offers, counted the way access reads them. */
export function pluginLocalToolSummary(
  tool: Pick<PluginLocalToolSummaryView, "toolCount" | "readOnlyToolCount">,
) {
  const reads = tool.readOnlyToolCount;
  const writes = tool.toolCount - reads;
  if (!tool.toolCount) return "No tools right now";
  return `${tool.toolCount} ${tool.toolCount === 1 ? "tool" : "tools"}: ${reads} ${
    reads === 1 ? "reads" : "read"
  }, ${writes} ${writes === 1 ? "writes" : "write"}`;
}

/**
 * What a local tool row says under its title, in a person's words. A device
 * app's title already names its computer; a local server's says where it runs.
 */
export function pluginLocalToolDetail(tool: PluginLocalToolSummaryView): string {
  return [pluginLocalToolStatus(tool).label, pluginLocalToolWhere(tool)]
    .filter(Boolean)
    .join(" · ");
}

/** Where a local server runs; null for a device app, whose title says it. */
export function pluginLocalToolWhere(
  tool: Pick<PluginLocalToolView, "kind" | "computer">,
): string | null {
  if (tool.kind === "device-app") return null;
  return tool.computer ? `Runs on ${tool.computer.name}` : "No computer to run on";
}

/**
 * The record a local tool stands for. Its id is the Host's stable provider id:
 * `app_device_<connection>` for a device data app, `app_server_<server>` for a
 * local server.
 */
export function pluginLocalToolSource(
  tool: Pick<PluginLocalToolView, "id">,
):
  | { readonly kind: "device-app"; readonly connectionId: string }
  | { readonly kind: "local-server"; readonly serverId: string }
  | null {
  if (tool.id.startsWith("app_device_"))
    return { kind: "device-app", connectionId: tool.id.slice("app_device_".length) };
  if (tool.id.startsWith("app_server_"))
    return { kind: "local-server", serverId: tool.id.slice("app_server_".length) };
  return null;
}

/** How agents address it in a program; for a line about exactly that, not for choosing access. */
export function pluginLocalToolAddress(tool: Pick<PluginLocalToolView, "name">) {
  return /^[a-z_$][a-z0-9_$]*$/iu.test(tool.name) ? `tools.${tool.name}` : `tools["${tool.name}"]`;
}

/* ---- Local servers: where they run, their state, secrets and removal ---- */

/** The installation records a local server lives in, as `integration.platform.get` lists them. */
export interface LocalServerInstallations {
  readonly installations: readonly {
    readonly installation: {
      readonly id: string;
      readonly title: string;
      readonly pluginId?: string | null | undefined;
    };
    readonly servers: readonly {
      readonly id: string;
      readonly name: string;
      readonly status: "active" | "disabled" | "needs-attention";
      readonly statusDetail: string | null;
    }[];
  }[];
}

/** One local server, found by its server id or by the plugin record that registered it. */
export function localServerRecord(
  platform: LocalServerInstallations,
  by: { readonly serverId: string } | { readonly pluginId: string },
) {
  for (const { installation, servers } of platform.installations) {
    const server =
      "serverId" in by
        ? servers.find(({ id }) => id === by.serverId)
        : installation.pluginId === by.pluginId
          ? servers[0]
          : undefined;
    if (!server) continue;
    return {
      pluginId: installation.pluginId ?? null,
      installationId: installation.id,
      serverId: server.id,
      title: installation.title,
      state: localServerState(server),
    };
  }
  return null;
}

/** A local server's state as a person reads it. */
export function localServerState(server: {
  readonly status: "active" | "disabled" | "needs-attention";
  readonly statusDetail: string | null;
}): { readonly label: string; readonly tone: PluginTone } {
  if (server.status === "active") return { label: "Approved", tone: "ok" };
  if (server.status === "disabled") return { label: "Turned off", tone: "muted" };
  return {
    label: server.statusDetail ?? "Waiting for approval on its computer",
    tone: "attention",
  };
}

/* ---- Skills in Agent home ---- */

/** The skills in the agent home folder, from the plugins overview, each with its switch. */
export function agentHomeSkills<Row extends { readonly target: { readonly kind: string } }>(
  rows: readonly Row[],
): readonly (Row & { readonly target: { readonly kind: "skill"; readonly fullName: string } })[] {
  return rows.filter(
    (
      row,
    ): row is Row & { readonly target: { readonly kind: "skill"; readonly fullName: string } } =>
      row.target.kind === "skill",
  );
}
