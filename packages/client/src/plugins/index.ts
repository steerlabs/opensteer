import cronstrue from "cronstrue";
import type { Request, RequestResponse } from "@opensteer/core";
import type {
  ConnectedAccountView,
  InstalledPluginView,
  PluginAccess,
  PluginAccountFieldView,
  PluginAccountReviewView,
  PluginAuthor,
  PluginCatalogEntryView,
  PluginCommand,
  PluginCommandResult,
  PluginConsentView,
  PluginEngineStateView,
  PluginLocalToolView,
  PluginRequirementTarget,
  PluginScheduleView,
  PluginScheduledRunView,
  PluginSummaryView,
  PluginWorkflowRunView,
} from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "../host/host-session-client.js";
import type { KeysetPage } from "../team/paged-list.js";

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

export function readInstalledPlugins(client: PluginsHost) {
  return client.rpc["plugins.installed.list"]({}).then(unwrapRpcResult);
}
export function readPlugin(client: PluginsHost, pluginId: string) {
  return client.rpc["plugins.get"]({ pluginId }).then(unwrapRpcResult);
}
export function readPluginPageView(client: PluginsHost, pluginId: string, theme: "light" | "dark") {
  return client.rpc["plugins.page.view"]({ pluginId, theme }).then(unwrapRpcResult);
}
export function readConnectedAccounts(client: PluginsHost) {
  return client.rpc["plugins.accounts.list"]({}).then(unwrapRpcResult);
}
export function readPluginAccountReview(client: PluginsHost, target: PluginRequirementTarget) {
  return client.rpc["plugins.account.review"](target).then(unwrapRpcResult);
}
export function readPluginScheduleRuns(client: PluginsHost, pluginId: string) {
  return client.rpc["plugins.schedule.runs"]({ pluginId }).then(unwrapRpcResult);
}
export function readPluginWorkflowRuns(client: PluginsHost, pluginId: string, cursor?: string) {
  return client.rpc["plugins.workflow.runs"]({ pluginId, ...(cursor ? { cursor } : {}) }).then(
    unwrapRpcResult,
  );
}
export function readPluginWebhookSetup(client: PluginsHost, pluginId: string, webhookId: string) {
  return client.rpc["plugins.webhook.setup.get"]({ pluginId, webhookId }).then(unwrapRpcResult);
}

export const pluginCatalogPageSize = 30;
/**
 * The catalog read page by page for one search. The Host pages it; a blank
 * search lists everything in the catalog's own order.
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
    return { items: page.items, nextCursor: page.cursor };
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
): Promise<Extract<PluginCommandResult, { type: T }>> {
  const result = await client.dispatch({
    ...input,
    type,
    idempotencyKey: mutationIdempotencyKey(type),
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
) => command(client, "plugins.account.create", input).then(({ account }) => account);
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
  requestId: Request["id"],
  response: RequestResponse,
) {
  return client.dispatch({
    type: "request.respond",
    idempotencyKey: mutationIdempotencyKey(`request:${requestId}`),
    requestId,
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
  if (plugin.status === "needs-account") return { label: "Connect an account", tone: "attention" };
  if (plugin.access === "off") return { label: "Off for agents", tone: "muted" };
  if (plugin.access === "read-only") return { label: "Read-only", tone: "ok" };
  return { label: "On", tone: "ok" };
}

/** What the engine's state means to someone waiting on it; null when nothing needs saying. */
export function pluginEngineNotice(
  engine: PluginEngineStateView | null,
): { readonly tone: "progress" | "error"; readonly text: string } | null {
  if (!engine) return null;
  if (engine.status === "starting")
    return { tone: "progress", text: "Starting plugins. The first open can take a few seconds." };
  if (engine.status === "unavailable")
    return {
      tone: "error",
      text: engine.reason
        ? `Plugins are unavailable: ${engine.reason}`
        : "Plugins are unavailable right now.",
    };
  return null;
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
 * linking places in that code, and who wrote it.
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
  return [
    {
      key: "sites",
      text: sites.length
        ? `${credential[0]!.toUpperCase()}${credential.slice(1)} may only be sent to ${listText(sites)}.`
        : `${input.pluginName} doesn't say which sites ${credential} may go to.`,
    },
    {
      key: "credential",
      text:
        consent.credential === "sealed"
          ? `${input.pluginName}'s code gets a sealed handle, never the credential itself.`
          : `${input.pluginName}'s code receives the credential itself.`,
    },
    {
      key: "trust",
      text: `Linking trusts ${input.pluginName}'s code with this account. Its setup runs with the account before any tool asks for approval.`,
    },
    {
      key: "author",
      text:
        input.author === "catalog"
          ? `${input.pluginName} comes from the plugin catalog.`
          : `${input.pluginName} was written by an agent. Nobody else reviewed its code.`,
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

/* ---- A tool's input form, from its JSON Schema ---- */

export interface PluginInputField {
  readonly id: string;
  readonly prompt: string;
  readonly description: string | null;
  readonly kind: "text" | "number" | "integer" | "boolean" | "choice" | "choices";
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly required: boolean;
}
export interface PluginInputForm {
  readonly fields: readonly PluginInputField[];
  /** Properties this form cannot render; the person can only decline. */
  readonly unsupported: readonly string[];
}

/** The flat MCP form schema a tool asks with, as fields the app's form components draw. */
export function pluginInputForm(schema: Record<string, unknown>): PluginInputForm {
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v) => typeof v === "string") : [],
  );
  const fields: PluginInputField[] = [];
  const unsupported: string[] = [];
  for (const [id, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      unsupported.push(id);
      continue;
    }
    const property = raw as Record<string, unknown>;
    const prompt = typeof property.title === "string" && property.title ? property.title : id;
    const description = typeof property.description === "string" ? property.description : null;
    const base = { id, prompt, description, required: required.has(id) };
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((value): value is string => typeof value === "string")
      : null;
    const oneOf = Array.isArray(property.oneOf)
      ? property.oneOf.flatMap((option) =>
          option &&
          typeof option === "object" &&
          typeof (option as { const?: unknown }).const === "string"
            ? [
                {
                  value: (option as { const: string }).const,
                  label:
                    typeof (option as { title?: unknown }).title === "string"
                      ? (option as { title: string }).title
                      : (option as { const: string }).const,
                },
              ]
            : [],
        )
      : null;
    const names = Array.isArray(property.enumNames) ? property.enumNames : [];
    if (property.type === "string" && (enumValues?.length || oneOf?.length)) {
      fields.push({
        ...base,
        kind: "choice",
        choices: oneOf?.length
          ? oneOf
          : enumValues!.map((value, index) => ({
              value,
              label: typeof names[index] === "string" ? (names[index] as string) : value,
            })),
      });
    } else if (property.type === "array") {
      const items = property.items as Record<string, unknown> | undefined;
      const values = Array.isArray(items?.enum)
        ? items.enum.filter((value): value is string => typeof value === "string")
        : Array.isArray(items?.anyOf)
          ? items.anyOf.flatMap((option) =>
              option &&
              typeof option === "object" &&
              typeof (option as { const?: unknown }).const === "string"
                ? [(option as { const: string }).const]
                : [],
            )
          : [];
      if (values.length)
        fields.push({
          ...base,
          kind: "choices",
          choices: values.map((value) => ({ value, label: value })),
        });
      else unsupported.push(id);
    } else if (property.type === "boolean") {
      fields.push({
        ...base,
        kind: "boolean",
        choices: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      });
    } else if (property.type === "number" || property.type === "integer") {
      fields.push({ ...base, kind: property.type, choices: [] });
    } else if (property.type === "string") {
      fields.push({ ...base, kind: "text", choices: [] });
    } else unsupported.push(id);
  }
  return { fields, unsupported };
}

/**
 * The content to send for a form's answers, or why it cannot be sent yet.
 * Answers are the app's form answers: each field's chosen or typed values.
 */
export function pluginInputContent(
  form: PluginInputForm,
  answers: Readonly<Record<string, readonly string[]>>,
):
  | { readonly content: Record<string, string | number | boolean | string[]> }
  | { readonly problem: string } {
  if (form.unsupported.length)
    return { problem: "This form asks for something Opensteer can't show. Decline it instead." };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of form.fields) {
    const values = answers[field.id] ?? [];
    const first = values[0]?.trim() ?? "";
    if (!values.length || (field.kind !== "choices" && first === "")) {
      if (field.required) return { problem: `${field.prompt} is required.` };
      continue;
    }
    if (field.kind === "choices") content[field.id] = [...values];
    else if (field.kind === "boolean") content[field.id] = first === "true";
    else if (field.kind === "number" || field.kind === "integer") {
      const number = Number(first);
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number)))
        return {
          problem: `${field.prompt} needs ${field.kind === "integer" ? "a whole number" : "a number"}.`,
        };
      content[field.id] = number;
    } else content[field.id] = first;
  }
  return { content };
}

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
export function pluginWorkflowRunLive(run: PluginWorkflowRunView) {
  return !["complete", "errored", "terminated"].includes(run.status);
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
  if (requirement.links.some((link) => !link.current))
    return "This plugin changed what it asks for. Review the account again.";
  if (requirement.cardinality === "one" && requirement.links.length === 0)
    return `Connect a ${requirement.providerName} account to use this plugin.`;
  return null;
}

export function pluginAccountLabel(account: ConnectedAccountView) {
  return account.label || account.id;
}

/* ---- Device data apps and local servers beside plugins ---- */

export type { PluginLocalToolView } from "@opensteer/protocol";

/** A local tool's state as a short label: why agents can't reach it first. */
export function pluginLocalToolStatus(tool: PluginLocalToolView): {
  readonly label: string;
  readonly tone: PluginTone;
} {
  if (tool.access === "off") return { label: "Off for agents", tone: "muted" };
  if (tool.unavailable) return { label: "Unavailable", tone: "attention" };
  if (tool.access === "read-only") return { label: "Read-only", tone: "ok" };
  return { label: "On", tone: "ok" };
}

/** What a local tool offers, counted the way access reads them. */
export function pluginLocalToolSummary(tool: Pick<PluginLocalToolView, "tools">) {
  const reads = tool.tools.filter(({ readOnly }) => readOnly).length;
  const writes = tool.tools.length - reads;
  if (!tool.tools.length) return "No tools right now";
  return `${tool.tools.length} ${tool.tools.length === 1 ? "tool" : "tools"}: ${reads} ${
    reads === 1 ? "reads" : "read"
  }, ${writes} ${writes === 1 ? "writes" : "write"}`;
}

/**
 * What a local tool row says under its title, in a person's words. A device
 * app's title already names its computer; a local server's says where it runs.
 */
export function pluginLocalToolDetail(tool: PluginLocalToolView): string {
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

/** The local tool agents reach for one local server, when there is one. */
export function pluginLocalToolForServer(
  tools: readonly PluginLocalToolView[],
  serverId: string,
): PluginLocalToolView | null {
  return tools.find((tool) => tool.id === `app_server_${serverId}`) ?? null;
}

/** Which way it reaches agents, as they type it. */
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
