import { createHash } from "node:crypto";
import { z } from "zod";
import { isLocalProviderId } from "./provider-names.js";
import {
  ownerManagementResults,
  EngineScheduledRunSchema,
  EngineScheduledApprovalSchema,
  EngineWorkflowRunSchema,
  EngineWorkflowRunPageSchema,
  EngineWebhookSetupSchema,
  EngineWebhookSchema,
} from "./engine-feature-schemas.js";
import { OpensteerError, type UserId } from "@opensteer/core";
import {
  PluginIconSchema,
  pluginDetailPreview,
  pluginLocalToolsMax,
  pluginReads,
  pluginRunsMax,
  pluginToolsMax,
  pluginsInstalledPageMax,
  rpcSuccess,
  type HostApiHandlers,
  type HostApiServerContext,
  type PluginChange,
  type PluginResourceCategory,
  type PluginCommand,
  type PluginCommandResult,
  type PluginEngineStateView,
  type PluginLocalToolView,
  type InstalledPluginView,
  type PluginRequirementView,
  type PluginSummaryView,
  type PluginToolView,
  type PluginVersionView,
} from "@opensteer/protocol";
import type { PluginAgentStore } from "@opensteer/database";
import { requireSession } from "../server/rpc-context.js";
import {
  PluginServiceError,
  ConsentSchema,
  type EngineAccountMetadata,
  type PluginCaller,
  type PluginConsent,
  type PluginJson,
} from "./engine-protocol.js";
import type { PluginService, PluginServiceState } from "./plugin-service.js";
import { keysetPage } from "./keyset-page.js";

/**
 * The person's own authority over their plugins. Every call acts as the
 * personal owner; no caller context ever comes from a client.
 */
const owner: PluginCaller = { caller: "personal", mode: "automatic" };
type LocalTool = Omit<PluginLocalToolView, "access" | "toolCount" | "readOnlyToolCount">;

type Service = Pick<
  PluginService,
  | "state"
  | "installed"
  | "detail"
  | "detailSection"
  | "scheduleApprovals"
  | "catalogList"
  | "catalogDetail"
  | "install"
  | "activate"
  | "remove"
  | "accounts"
  | "createApiKeyAccount"
  | "removeAccount"
  | "reviewAccountLink"
  | "linkAccount"
  | "unlinkAccount"
  | "manage"
>;

export interface PluginOwnerApiOptions {
  readonly service: Service;
  readonly pages?: import("./plugin-pages.js").PluginPages;
  readonly webhooks?: {
    service: Pick<PluginService, "webhook" | "readStream">;
    origin: () => Promise<string | undefined>;
  };
  readonly settings: Pick<
    PluginAgentStore,
    "settings" | "versionAuthors" | "setAccess" | "recordInstall" | "recordActivation"
  >;
  /** Fulfils Requests waiting on this link; called after a person-reviewed link commits. */
  readonly accountLinked: (input: {
    owner: UserId;
    plugin: string;
    requirement: string;
    scope: "app" | "user";
    consent: PluginConsent;
    settlementSessionId?: string;
  }) => Promise<void>;
  readonly assertOwner: (userId: UserId) => Promise<void>;
  /** The owner's device data apps and local servers in the plugin namespace, read live. */
  readonly localTools?: (owner: UserId, id?: string) => Promise<readonly LocalTool[]>;
  readonly cancelPlugin?: (owner: UserId, plugin: string) => Promise<void>;
  /** Tells the owner's clients to reread what they show. */
  readonly changed: (owner: UserId, change?: PluginChange) => void;
}

const settingsRow = z.object({
  pluginId: z.string(),
  access: z.enum(["all", "read-only", "off"]),
  author: z.enum(["catalog", "agent"]),
  versionAuthors: z.record(z.string(), z.enum(["catalog", "agent"])),
});
type Settings = z.infer<typeof settingsRow>;

export function pluginEngineStateView(state: PluginServiceState): PluginEngineStateView {
  const status =
    state.status === "ready"
      ? "ready"
      : state.status === "starting" || state.status === "restarting"
        ? "starting"
        : state.status === "unavailable"
          ? "unavailable"
          : "idle";
  return {
    status,
    ...(state.unavailable ? { unavailable: state.unavailable } : {}),
    ...(status === "unavailable" && state.reason ? { reason: state.reason.slice(0, 500) } : {}),
  };
}

const icon = z.object({ src: z.string(), theme: z.string().optional() });
function pickIcon(value: unknown): string | null {
  const icons = z.array(icon).safeParse(value);
  if (!icons.success) return null;
  const ordered = [...icons.data].sort(
    (a, b) => Number(a.theme === "dark") - Number(b.theme === "dark"),
  );
  for (const candidate of ordered)
    if (PluginIconSchema.safeParse(candidate.src).success) return candidate.src;
  return null;
}

const requirementSchema = z.object({
  scope: z.enum(["app", "user"]),
  provider: z.string(),
  cardinality: z.enum(["one", "many"]),
  definition: z.object({ name: z.string().min(1) }).passthrough(),
});
function requirements(plugin: { requirements: { accounts: Record<string, unknown> } }) {
  return Object.entries(plugin.requirements.accounts).flatMap(([name, value]) => {
    return [[name, requirementSchema.parse(value)] as const];
  });
}

function authorOf(row: Settings | undefined, version: string | null) {
  return (version ? row?.versionAuthors[version] : undefined) ?? row?.author ?? "agent";
}

function summary(
  plugin: {
    id: string;
    name: string;
    slug: string;
    activeVersion: string | null;
    requirements: { accounts: Record<string, unknown>; icons?: unknown };
  },
  { links, readiness }: EngineAccountMetadata,
  row: Settings | undefined,
): PluginSummaryView {
  const required = requirements(plugin);
  const linked = required.filter(([name, r]) =>
    links.some((link) => link.requirement === name && link.scope === r.scope),
  );
  const states = Object.values(readiness).map(({ state }) => state);
  const accountReadiness = states.includes("consent-needs-review")
    ? "consent-needs-review"
    : states.includes("required-but-missing")
      ? "required-but-missing"
      : "usable";
  return {
    id: plugin.id,
    name: plugin.name.slice(0, 240),
    slug: plugin.slug.slice(0, 240),
    icon: pickIcon(plugin.requirements.icons),
    author: authorOf(row, plugin.activeVersion),
    access: row?.access ?? "all",
    activeVersion: plugin.activeVersion,
    status:
      plugin.activeVersion === null
        ? "not-built"
        : accountReadiness === "usable"
          ? "ready"
          : "needs-account",
    accountReadiness,
    accounts: { required: required.length, linked: linked.length },
  };
}

function each<T>(values: unknown[], schema: z.ZodType<T>, max: number): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (result.length >= max) break;
    result.push(schema.parse(value));
  }
  return result;
}
const iso = (value: unknown) => {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};
const clip = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

/** Plugins that need the person come first, as the list groups them. */
const installedKey = (plugin: PluginSummaryView) =>
  `${plugin.status === "ready" ? 1 : 0}\u0000${plugin.name.toLocaleLowerCase()}\u0000${plugin.id}`;
const nameKey = (item: { name: string }) => item.name;
const versionKey = (version: PluginVersionView) => `${version.createdAt ?? ""}\u0000${version.id}`;

/** A provider no installed plugin names any more still reads as a word, not an identifier. */
function providerTitle(provider: string) {
  const words = provider.replace(/[-_]+/gu, " ").trim();
  return words ? `${words[0]!.toLocaleUpperCase()}${words.slice(1)}` : provider;
}

const webhookView = (w: z.infer<typeof EngineWebhookSchema>) => ({
  id: w.id,
  name: w.name.slice(0, 240),
  status: w.status,
  failure: w.failure,
  account: w.sourceAccount,
  createdAt: w.createdAt,
});

/** Engine refusals keep their meaning on the wire; an engine that is starting says so. */
function hostError(error: unknown): never {
  if (error instanceof PluginServiceError) {
    const code =
      error.code === "invalid"
        ? "bad_request"
        : error.code === "forbidden"
          ? "forbidden"
          : error.code === "cancelled" || error.code === "interrupted"
            ? "timeout"
            : "conflict";
    throw new OpensteerError({
      code,
      message:
        error.tag === "AppWebhooksActive"
          ? "Remove this plugin's webhook subscriptions before removing the plugin."
          : error.tag === "AppWorkflowsActive"
            ? "Stop this plugin's workflow runs before removing the plugin."
            : error.message.slice(0, 1_000) || "The plugin engine refused this.",
      reason:
        error.tag === "AccountFieldsInvalid"
          ? "plugin-key-invalid"
          : error.tag === "AppWebhooksActive"
            ? "plugin-webhooks-active"
            : error.tag === "AppWorkflowsActive"
              ? "plugin-workflows-active"
              : error.code === "unavailable"
                ? "plugin-engine-unavailable"
                : `plugin-${error.code}`,
    });
  }
  throw error;
}

type EngineDetail = Awaited<ReturnType<Service["detail"]>>;
/** A plugin's tools, skills and versions whole, in the shapes the detail and its pages send. */
function sections(detail: EngineDetail, row: Settings | undefined) {
  const tools: PluginToolView[] | null = detail.tools
    ? each(
        detail.tools.items,
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          readOnly: z.boolean().optional(),
        }),
        detail.tools.items.length,
      ).map((tool) => ({
        name: tool.name.slice(0, 240),
        description: (tool.description ?? "").slice(0, 2_000),
        readOnly: tool.readOnly === true,
      }))
    : null;
  const skills =
    detail.skills === null
      ? null
      : detail.skills.skills.map((skill) => ({
          name: skill.name.slice(0, 240),
          description: (skill.description ?? "").slice(0, 2_000),
        }));
  const versions: PluginVersionView[] = z
    .array(z.object({ id: z.string().min(1), createdAt: z.iso.datetime() }))
    .parse(detail.versions)
    .map((version) => ({
      id: version.id,
      createdAt: iso(version.createdAt),
      active: version.id === detail.plugin.activeVersion,
      author: authorOf(row, version.id),
    }));
  return { tools, skills, versions };
}

export class PluginOwnerApi {
  readonly #options: PluginOwnerApiOptions;
  readonly pages: PluginOwnerApiOptions["pages"];
  readonly webhooks: PluginOwnerApiOptions["webhooks"];
  #gateway: import("../apps/app-gateway.js").AppGateway | undefined;
  gateway(gateway: import("../apps/app-gateway.js").AppGateway) {
    this.#gateway = gateway;
  }
  /** Retried commands from a weak connection resolve to the first attempt's result. */
  readonly #recent = new Map<string, Promise<PluginCommandResult>>();
  /** A start begun for a list that went out without plugins; it tells the owner when it ends. */
  #warming: Promise<void> | undefined;
  constructor(options: PluginOwnerApiOptions) {
    this.#options = options;
    this.pages = options.pages;
    this.webhooks = options.webhooks;
  }

  async #owner(context: HostApiServerContext) {
    const session = requireSession(context);
    await this.#options.assertOwner(session.user.id);
    return session;
  }
  /** Access for every plugin, and authors for only the versions named. */
  async #settings(
    userId: UserId,
    versions: readonly { pluginId: string; version: string | null }[] = [],
  ) {
    const named = versions.flatMap(({ pluginId, version }) =>
      version ? [{ pluginId, version }] : [],
    );
    const [rows, authors] = await Promise.all([
      this.#options.settings.settings(userId),
      this.#options.settings.versionAuthors(userId, named),
    ]);
    return z.array(settingsRow).parse(
      rows.map((row) => ({
        ...row,
        versionAuthors: Object.fromEntries(
          named.flatMap(({ pluginId, version }) => {
            const author = authors.get(`${pluginId}\u0000${version}`);
            return pluginId === row.pluginId && author ? [[version, author]] : [];
          }),
        ),
      })),
    );
  }
  #call<T>(promise: Promise<T>): Promise<T> {
    return promise.catch(hostError);
  }

  async #webhookIssue(urls: readonly string[]) {
    const origin = await this.webhooks?.origin();
    if (!origin)
      return "No public callback address is currently available. Webhooks cannot be received; enable Connect or use a public Host address.";
    return urls.some((url) => new URL(url).origin !== origin)
      ? "This webhook uses a previous public address. Remove it and reconnect its source to register the current address."
      : null;
  }

  /**
   * The first screen of Plugins. Local tools never wait for the engine: while it is not ready the
   * list goes out without plugins, the engine starts, and a change notice follows once it can say.
   */
  async installed(userId: UserId, signal?: AbortSignal) {
    const service = this.#options.service;
    const ready = service.state().status === "ready";
    const [plugins, settings, local] = await Promise.all([
      ready ? this.#summaries(userId, signal) : null,
      this.#settings(userId),
      this.#options.localTools?.(userId) ?? [],
    ]);
    if (!ready || plugins === null) this.#warm(userId);
    const engine = pluginEngineStateView(service.state());
    const access = (id: string) => settings.find((row) => row.pluginId === id)?.access ?? "all";
    const page = plugins
      ? keysetPage(plugins, installedKey, { scope: "installed", max: pluginsInstalledPageMax })
      : null;
    return {
      engine: this.#warming && engine.status === "idle" ? { status: "starting" as const } : engine,
      plugins: page?.items ?? null,
      cursor: page?.cursor ?? null,
      local: local
        .slice(0, pluginLocalToolsMax)
        .map(({ tools, ...tool }) => ({
          ...tool,
          toolCount: tools.length,
          readOnlyToolCount: tools.filter(({ readOnly }) => readOnly).length,
          access: access(tool.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Every installed plugin as the list shows it; null while the engine is unavailable. */
  async #summaries(userId: UserId, signal?: AbortSignal): Promise<PluginSummaryView[] | null> {
    const rows = await this.#options.service
      .installed({}, owner, signal)
      .catch((error: unknown) => {
        if (error instanceof PluginServiceError && error.code === "unavailable") return null;
        return hostError(error);
      });
    const settings = await this.#settings(
      userId,
      (rows ?? []).map(({ plugin }) => ({ pluginId: plugin.id, version: plugin.activeVersion })),
    );
    return (
      rows?.map((installed) =>
        summary(
          installed.plugin,
          installed,
          settings.find((row) => row.pluginId === installed.plugin.id),
        ),
      ) ?? null
    );
  }

  #warm(userId: UserId) {
    if (this.#warming || this.#options.service.state().status === "unavailable") return;
    this.#warming = this.#options.service
      .installed({}, owner)
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.#warming = undefined;
        this.#options.changed(userId);
      });
  }

  async detail(userId: UserId, pluginId: string, signal?: AbortSignal) {
    const service = this.#options.service;
    const [detail, accounts] = await Promise.all([
      this.#call(service.detail({ plugin: pluginId }, owner, signal)),
      this.#call(service.accounts({}, owner, signal)),
    ]);
    const settings = await this.#settings(userId, [
      { pluginId, version: detail.plugin.activeVersion },
      ...z
        .array(z.object({ id: z.string() }))
        .parse(detail.versions)
        .map(({ id }) => ({ pluginId, version: id })),
    ]);
    const row = settings.find((entry) => entry.pluginId === pluginId);
    const plugin = detail.plugin;
    const requirementViews: PluginRequirementView[] = requirements(plugin)
      .slice(0, 50)
      .map(([name, r]) => {
        const readiness = detail.readiness[name]!;
        return {
          name,
          scope: r.scope,
          provider: r.provider,
          providerName: r.definition.name.slice(0, 240),
          cardinality: r.cardinality,
          readiness: readiness.state,
          consent: readiness.consent,
          links: detail.links
            .filter((link) => link.requirement === name && link.scope === r.scope)
            .slice(0, 50)
            .map((link) => {
              const account = accounts.find((entry) => entry.id === link.account);
              return {
                account: {
                  id: link.account,
                  provider: r.provider,
                  label: (account?.label || link.account).slice(0, 240),
                },
                current: link.current,
              };
            }),
        };
      });
    const { tools, skills, versions } = sections(detail, row);
    const view: InstalledPluginView = {
      plugin: summary(plugin, detail, row),
      requirements: requirementViews,
      ...(detail.importWarnings ? { importWarnings: detail.importWarnings } : {}),
      tools:
        tools && keysetPage(tools, nameKey, { scope: "", max: pluginDetailPreview.tools }).items,
      toolCount: detail.toolCount,
      skills:
        skills && keysetPage(skills, nameKey, { scope: "", max: pluginDetailPreview.skills }).items,
      skillCount: detail.skillCount,
      versions: keysetPage(versions, versionKey, {
        scope: "",
        max: pluginDetailPreview.versions,
        descending: true,
      }).items,
      versionCount: detail.versionCount,
      schedules: detail.schedules.slice(0, 50).map((schedule) => ({
        name: schedule.name.slice(0, 240),
        tool: schedule.tool.slice(0, 240),
        timing:
          schedule.timing.kind === "interval"
            ? schedule.timing
            : {
                kind: "cron" as const,
                expression: schedule.timing.calendar.expression.slice(0, 200),
                timezone: schedule.timing.calendar.timezone.slice(0, 100),
              },
        settings: schedule.settings
          ? {
              id: schedule.settings.id,
              enabled: schedule.settings.enabled,
              approvalMode: schedule.settings.approvalMode,
              nextAt: iso(schedule.settings.nextAt),
              running: schedule.settings.activeRun !== null,
              accountRequired: schedule.settings.accountRequired?.slice(0, 240) ?? null,
            }
          : null,
      })),
      workflows:
        detail.workflows === null
          ? null
          : detail.workflows.slice(0, 50).map((workflow) => ({
              name: workflow.name.slice(0, 240),
              description: workflow.description?.slice(0, 2_000) ?? null,
              inputSchema: workflow.inputSchema,
            })),
      webhooks: detail.webhooks.slice(0, 50).map(webhookView),
      backgroundUnavailable:
        row?.access === "off"
          ? "This plugin is off. Its schedules, webhooks and workflows cannot run."
          : row?.access === "read-only"
            ? "This plugin is read-only. Its schedules, webhooks and workflows cannot run."
            : requirementViews.some(({ readiness }) => readiness === "consent-needs-review")
              ? "Review and link the changed account declaration before this plugin can run."
              : null,
      webhookUnavailable: await this.#webhookIssue(
        detail.webhooks.map((webhook) => webhook.callbackUrl),
      ),
      page: detail.hasPage
        ? {
            reference: { kind: "plugin", pluginId },
            unavailable:
              row?.access === "off"
                ? "Turn this plugin on to open its page."
                : this.pages
                  ? null
                  : "Plugin pages are unavailable on this Host.",
          }
        : null,
    };
    return pluginReads["plugins.get"].output.parse(view);
  }

  async review(
    input: { pluginId: string; requirement: string; scope: "app" | "user" },
    userId: UserId,
    signal?: AbortSignal,
  ) {
    const service = this.#options.service;
    const target = { plugin: input.pluginId, requirement: input.requirement, scope: input.scope };
    const [[detail], accounts] = await Promise.all([
      this.#call(service.installed({ plugins: [input.pluginId] }, owner, signal)),
      this.#call(service.accounts({}, owner, signal)),
    ]);
    const requirement =
      detail &&
      requirements(detail.plugin).find(
        ([name, r]) => name === input.requirement && r.scope === input.scope,
      )?.[1];
    if (!detail || !requirement)
      throw new OpensteerError({
        code: "conflict",
        reason: "plugin-consent-changed",
        message: "This plugin no longer asks for that account.",
      });
    const consent =
      detail.readiness[input.requirement]?.consent ??
      (await this.#call(service.reviewAccountLink(target, owner, signal)));
    const settings = await this.#settings(userId, [
      { pluginId: input.pluginId, version: detail.plugin.activeVersion },
    ]);
    const fieldSchema = z.object({
      type: z.enum(["string", "number", "integer", "boolean"]),
      title: z.string().optional(),
      description: z.string().optional(),
      enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    });
    const nullable = z.object({
      anyOf: z.array(z.unknown()),
      title: z.string().optional(),
      description: z.string().optional(),
    });
    const methods = Object.entries(
      z.record(z.string(), z.unknown()).catch({}).parse(requirement.definition.auth),
    )
      .flatMap(([method, value]) => {
        const declared = z
          .object({
            type: z.literal("secrets"),
            label: z.string(),
            fields: z.object({
              properties: z.record(z.string(), z.unknown()),
              required: z.array(z.string()).optional(),
            }),
            plain: z.array(z.string()).optional(),
          })
          .safeParse(value);
        if (!declared.success) return [];
        const fields = Object.entries(declared.data.fields.properties).flatMap(([name, raw]) => {
          let field = fieldSchema.safeParse(raw).data;
          if (!field) {
            const wrapped = nullable.safeParse(raw).data;
            const inner = wrapped?.anyOf
              .map((option) => fieldSchema.safeParse(option).data)
              .find((option) => option !== undefined);
            if (inner && wrapped)
              field = {
                ...inner,
                ...(wrapped.title ? { title: wrapped.title } : {}),
                ...(wrapped.description ? { description: wrapped.description } : {}),
              };
          }
          if (!field) return [];
          return [
            {
              name: name.slice(0, 240),
              title: (field.title ?? name).slice(0, 240),
              description: field.description?.slice(0, 1_000) ?? null,
              type: field.type,
              choices: field.enum?.slice(0, 100) ?? null,
              required: declared.data.fields.required?.includes(name) ?? false,
              plain: declared.data.plain?.includes(name) ?? false,
            },
          ];
        });
        return [{ method, label: declared.data.label.slice(0, 240) || method, fields }];
      })
      .slice(0, 8);
    const row = settings.find((entry) => entry.pluginId === input.pluginId);
    return pluginReads["plugins.account.review"].output.parse({
      plugin: {
        id: detail.plugin.id,
        name: detail.plugin.name.slice(0, 240),
        author: authorOf(row, detail.plugin.activeVersion),
      },
      requirement: {
        name: input.requirement,
        scope: input.scope,
        provider: requirement.provider,
        providerName: requirement.definition.name.slice(0, 240),
        cardinality: requirement.cardinality,
      },
      consent,
      methods,
      signIn: Object.values(
        z.record(z.string(), z.unknown()).catch({}).parse(requirement.definition.auth),
      ).some((value) => z.object({ type: z.literal("oauth2") }).safeParse(value).success),
      accounts: accounts
        .filter((account) => account.provider === requirement.provider)
        .slice(0, 100)
        .map((account) => ({
          id: account.id,
          provider: account.provider,
          label: account.label.slice(0, 240),
        })),
      linked: each(
        detail.links,
        z.object({ requirement: z.string(), scope: z.string(), account: z.string() }),
        500,
      )
        .filter((link) => link.requirement === input.requirement && link.scope === input.scope)
        .map((link) => link.account)
        .slice(0, 50),
    });
  }

  /** The reads, registered on a personal Host only. */
  reads(): Pick<HostApiHandlers, keyof typeof pluginReads> {
    const service = this.#options.service;
    return {
      "plugins.page.view": async (input, context) => {
        const session = await this.#owner(context);
        if (!this.pages)
          throw new OpensteerError({ code: "not_found", message: "Plugin pages are unavailable" });
        const view = await this.pages.view(session.user.id, input.pluginId, input.theme);
        const entryUrl = this.#gateway?.entryUrl(
          input.pluginId,
          session,
          input.theme,
          context.headers,
          "plugin",
        );
        return rpcSuccess({ ...view, ...(entryUrl ? { entryUrl } : {}) });
      },
      "plugins.installed.list": async (_input, context) => {
        const session = await this.#owner(context);
        return rpcSuccess(await this.installed(session.user.id));
      },
      "plugins.installed.page": async (input, context) => {
        const session = await this.#owner(context);
        const plugins = await this.#summaries(session.user.id);
        if (plugins === null)
          throw new OpensteerError({
            code: "conflict",
            reason: "plugin-engine-unavailable",
            message: this.#options.service.state().reason ?? "The plugin engine is unavailable.",
          });
        const page = keysetPage(plugins, installedKey, {
          scope: "installed",
          cursor: input.cursor,
          max: pluginsInstalledPageMax,
        });
        return rpcSuccess({ plugins: page.items, cursor: page.cursor });
      },
      "plugins.local.get": async (input, context) => {
        const session = await this.#owner(context);
        const [local, settings] = await Promise.all([
          isLocalProviderId(input.id)
            ? (this.#options.localTools?.(session.user.id, input.id) ?? [])
            : [],
          this.#settings(session.user.id),
        ]);
        const tool = local.find((entry) => entry.id === input.id);
        if (!tool)
          throw new OpensteerError({
            code: "not_found",
            message:
              "This isn't available to agents anymore. It may have been removed on its device.",
          });
        const tools = tool.tools.slice(0, pluginToolsMax);
        return rpcSuccess({
          ...tool,
          tools,
          toolCount: tool.tools.length,
          readOnlyToolCount: tool.tools.filter(({ readOnly }) => readOnly).length,
          access: settings.find((row) => row.pluginId === tool.id)?.access ?? "all",
        });
      },
      "plugins.get": async (input, context) => {
        const session = await this.#owner(context);
        return rpcSuccess(await this.detail(session.user.id, input.pluginId));
      },
      "plugins.tools.list": async (input, context) => {
        await this.#owner(context);
        const page = await this.#call(
          service.detailSection(
            {
              plugin: input.pluginId,
              section: "tools",
              ...(input.cursor ? { cursor: input.cursor } : {}),
            },
            owner,
          ),
        );
        return rpcSuccess({
          tools: z
            .array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() }))
            .parse(page.items),
          cursor: page.cursor,
        });
      },
      "plugins.skills.list": async (input, context) => {
        await this.#owner(context);
        const page = await this.#call(
          service.detailSection(
            {
              plugin: input.pluginId,
              section: "skills",
              ...(input.cursor ? { cursor: input.cursor } : {}),
            },
            owner,
          ),
        );
        return rpcSuccess({
          skills: z
            .array(z.object({ name: z.string(), description: z.string() }))
            .parse(page.items),
          cursor: page.cursor,
        });
      },
      "plugins.versions.list": async (input, context) => {
        const session = await this.#owner(context);
        const page = await this.#call(
          service.detailSection(
            {
              plugin: input.pluginId,
              section: "versions",
              ...(input.cursor ? { cursor: input.cursor } : {}),
            },
            owner,
          ),
        );
        const items = z
          .array(z.object({ id: z.string(), createdAt: z.string(), active: z.boolean() }))
          .parse(page.items);
        const row = (
          await this.#settings(
            session.user.id,
            items.map(({ id }) => ({ pluginId: input.pluginId, version: id })),
          )
        ).find((entry) => entry.pluginId === input.pluginId);
        const versions = items.map((version) => ({
          ...version,
          author: authorOf(row, version.id),
        }));
        return rpcSuccess({ versions, cursor: page.cursor });
      },
      "plugins.catalog.list": async (input, context) => {
        await this.#owner(context);
        const page = await this.#call(
          service.catalogList(
            {
              ...(input.search?.trim() ? { search: input.search.trim() } : {}),
              ...(input.cursor ? { cursor: input.cursor } : {}),
              limit: input.limit ?? 30,
            },
            owner,
          ),
        );
        return rpcSuccess({
          items: page.items.map(catalogEntry),
          cursor: page.cursor && page.cursor.length <= 2_048 ? page.cursor : null,
        });
      },
      "plugins.catalog.get": async (input, context) => {
        await this.#owner(context);
        return rpcSuccess(
          catalogEntry(await this.#call(service.catalogDetail({ id: input.catalogId }, owner))),
        );
      },
      "plugins.accounts.list": async (_input, context) => {
        await this.#owner(context);
        const [accounts, installed] = await Promise.all([
          this.#call(service.accounts({}, owner)),
          this.#call(service.installed({}, owner)),
        ]);
        const providerNames = new Map<string, string>();
        const linked = new Map<string, Map<string, string>>();
        for (const { plugin, links } of installed) {
          for (const [, requirement] of requirements(plugin))
            providerNames.set(requirement.provider, requirement.definition.name);
          for (const { account } of links)
            linked.set(
              account,
              (linked.get(account) ?? new Map()).set(plugin.id, plugin.name.slice(0, 240)),
            );
        }
        return rpcSuccess({
          accounts: accounts
            .slice(0, 500)
            .map((account) => ({
              id: account.id,
              provider: account.provider,
              providerName: (
                providerNames.get(account.provider) ?? providerTitle(account.provider)
              ).slice(0, 240),
              label: account.label.slice(0, 240),
              links: [...(linked.get(account.id) ?? [])]
                .map(([pluginId, pluginName]) => ({ pluginId, pluginName }))
                .sort((a, b) => a.pluginName.localeCompare(b.pluginName))
                .slice(0, 50),
            }))
            .sort(
              (a, b) =>
                a.providerName.localeCompare(b.providerName) || a.label.localeCompare(b.label),
            ),
        });
      },
      "plugins.account.review": async (input, context) => {
        const session = await this.#owner(context);
        return rpcSuccess(await this.review(input, session.user.id));
      },
      "plugins.schedule.runs": async (input, context) => {
        await this.#owner(context);
        const [pending, history] = await Promise.all([
          this.#call(
            service.scheduleApprovals(
              {
                plugin: input.pluginId,
                ...(input.cursor ? { cursor: input.cursor } : {}),
              },
              owner,
            ),
          ),
          input.cursor
            ? []
            : this.#call(
                service.manage(
                  {
                    operation: "schedules.runs",
                    input: {
                      app: input.pluginId,
                      limit: pluginRunsMax,
                      ...(input.pending ? { pending: true } : {}),
                    },
                  },
                  owner,
                ),
              ),
        ]);
        const recent = z.array(EngineScheduledRunSchema).parse(history).slice(0, pluginRunsMax);
        const invocations = new Map(
          await Promise.all(
            pending.runs.map(async ({ id }) => {
              const raw = await this.#call(
                service
                  .manage(
                    {
                      operation: "schedules.approval",
                      input: { run: id },
                    },
                    owner,
                  )
                  .catch((error: unknown) => {
                    if (error instanceof PluginServiceError && error.tag === "ScheduleNotFound")
                      return null;
                    throw error;
                  }),
              );
              if (raw === null) return [id, null] as const;
              const { invocation } = EngineScheduledApprovalSchema.parse(raw);
              return [id, { tool: invocation.tool, arguments: invocation.input }] as const;
            }),
          ),
        );
        const view = (run: z.infer<typeof EngineScheduledRunSchema>) => ({
          id: run.id,
          schedule: run.name.slice(0, 240) || run.id,
          status: run.status,
          scheduledAt: iso(run.scheduledAt),
          expiresAt: iso(run.expiresAt),
          failure: run.failure?.slice(0, 1_000) ?? null,
          approval: invocations.get(run.id) ?? null,
        });
        return rpcSuccess({
          cursor: pending.next,
          pending: pending.runs.filter(({ id }) => invocations.get(id)).map(view),
          runs: recent.map(view),
        });
      },
      "plugins.workflow.runs": async (input, context) => {
        await this.#owner(context);
        const page = EngineWorkflowRunPageSchema.parse(
          await this.#call(
            service.manage(
              {
                operation: "workflowRuns.list",
                input: {
                  app: input.pluginId,
                  limit: String(pluginRunsMax),
                  live: true,
                  ...(input.workflow ? { workflow: input.workflow } : {}),
                  ...(input.runIds ? { runIds: input.runIds } : {}),
                  ...(input.cursor ? { cursor: input.cursor } : {}),
                },
              },
              owner,
            ),
          ),
        );
        return rpcSuccess({
          runs: page.items.slice(0, pluginRunsMax).map((run) => ({
            id: run.id,
            workflow: run.workflow.slice(0, 240),
            status: run.status,
            createdAt: run.createdAt.slice(0, 64),
            failure:
              (run.status === "errored" ? (run.failure?.message ?? run.error) : null)?.slice(
                0,
                1_000,
              ) ?? null,
          })),
          cursor: page.next && page.next.length <= 512 ? page.next : null,
        });
      },
      "plugins.webhook.setup.get": async (input, context) => {
        await this.#owner(context);
        const setup = EngineWebhookSetupSchema.parse(
          await this.#call(
            service.manage(
              {
                operation: "webhookSetup.read",
                input: { app: input.pluginId, subscription: input.webhookId },
              },
              owner,
            ),
          ),
        );
        return rpcSuccess({
          unavailable: await this.#webhookIssue([setup.subscription.callbackUrl]),
          step: setup.step,
          webhook: webhookView(setup.subscription),
          callbackUrl: setup.subscription.callbackUrl.slice(0, 2_048),
          instructions: setup.step !== "done" ? setup.instructions.slice(0, 8_000) : null,
          revision: setup.step === "configure" ? setup.revision.slice(0, 200) : null,
          stateSchema: setup.step === "configure" ? setup.stateSchema : null,
          signingSecret:
            setup.step === "configure" && "value" in setup.signingSecret
              ? setup.signingSecret.value.slice(0, 1_000)
              : null,
        });
      },
    };
  }

  /** `commands.dispatch` for plugin commands; the caller has already parsed the command. */
  async command(command: PluginCommand, context: HostApiServerContext) {
    const session = await this.#owner(context);
    const key = `${session.user.id}:${command.type}:${command.idempotencyKey}`;
    const existing = this.#recent.get(key);
    if (existing) return existing;
    const result = this.#run(command, session.user.id, session.id);
    this.#recent.set(key, result);
    result.catch(() => this.#recent.delete(key));
    if (this.#recent.size > 200) this.#recent.delete(this.#recent.keys().next().value!);
    return result;
  }

  async #run(
    command: PluginCommand,
    userId: UserId,
    sessionId: string,
  ): Promise<PluginCommandResult> {
    const { service, settings } = this.#options;
    const creationKey = JSON.stringify([userId, command.type, command.idempotencyKey]);
    const changed = () => this.#options.changed(userId);
    const resourceChanged = (pluginId: string, ...categories: PluginResourceCategory[]) =>
      this.#options.changed(userId, { pluginId, categories });
    const manage = async (operation: keyof typeof ownerManagementResults, input: object) =>
      ownerManagementResults[operation].parse(
        await this.#call(
          service.manage({ operation, input: input as Record<string, PluginJson> }, owner),
        ),
      );
    switch (command.type) {
      case "plugins.install": {
        const source = command.source;
        const result = await this.#call(
          service.install(
            source.kind === "catalog"
              ? { kind: "catalog", id: source.catalogId, key: creationKey }
              : { kind: source.kind, url: source.url, name: source.name, key: creationKey },
            owner,
          ),
        );
        if (result.status === "build-error") {
          const message = z.object({ message: z.string() }).safeParse(result.error).data?.message;
          return {
            type: command.type,
            result: {
              status: "build-error",
              message: (message ?? "The plugin did not build.").slice(0, 4_000),
            },
          };
        }
        // Catalog code is reviewed upstream; a URL wrapper is generated code nobody reviewed.
        await settings.recordInstall(
          userId,
          result.plugin.id,
          result.version.id,
          result.origin === "catalog" ? "catalog" : "agent",
        );
        changed();
        return {
          type: command.type,
          result: {
            status: "installed",
            pluginId: result.plugin.id,
            versionId: result.version.id,
            ...(result.warnings ? { warnings: result.warnings } : {}),
          },
        };
      }
      case "plugins.version.activate":
        await this.#call(
          service.activate({ plugin: command.pluginId, version: command.versionId }, owner),
        );
        await settings.recordActivation(userId, command.pluginId, command.versionId);
        changed();
        return { type: command.type };
      case "plugins.remove":
        await this.#call(service.remove({ plugin: command.pluginId }, owner));
        await this.#options.cancelPlugin?.(userId, command.pluginId);
        this.pages?.forget(command.pluginId);
        changed();
        return { type: command.type };
      case "plugins.access.set":
        await settings.setAccess(userId, command.pluginId, command.access);
        if (command.access === "off") await this.#options.cancelPlugin?.(userId, command.pluginId);
        changed();
        return { type: command.type, access: command.access };
      case "plugins.account.create": {
        const account = await this.#call(
          service.createApiKeyAccount(
            {
              provider: command.provider,
              method: command.method,
              fields: command.fields,
              key: creationKey,
              ...(command.label ? { label: command.label } : {}),
            },
            owner,
          ),
        );
        if (command.link)
          await this.#link({ ...command.link, accountId: account.id }, userId, sessionId);
        changed();
        return {
          type: command.type,
          account: {
            id: account.id,
            provider: account.provider,
            label: account.label.slice(0, 240),
          },
        };
      }
      case "plugins.account.remove": {
        const { affectedPlugins } = await this.#call(
          service.removeAccount({ account: command.accountId }, owner),
        );
        await Promise.all(
          affectedPlugins.map((plugin) => this.#options.cancelPlugin?.(userId, plugin)),
        );
        changed();
        return { type: command.type };
      }
      case "plugins.account.link":
        await this.#link(command, userId, sessionId);
        changed();
        return { type: command.type };
      case "plugins.account.unlink":
        await this.#call(
          service.unlinkAccount(
            {
              plugin: command.pluginId,
              requirement: command.requirement,
              scope: command.scope,
              account: command.accountId,
            },
            owner,
          ),
        );
        await this.#options.cancelPlugin?.(userId, command.pluginId);
        changed();
        return { type: command.type };
      case "plugins.schedule.configure":
        await manage("schedules.configure", {
          app: command.pluginId,
          name: command.schedule,
          enabled: command.enabled,
          key: creationKey,
          ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
        });
        resourceChanged(command.pluginId, "schedules");
        return { type: command.type };
      case "plugins.schedule.answer":
        await manage("schedules.answer", { run: command.runId, action: command.action });
        resourceChanged(command.pluginId, "scheduledRuns");
        return { type: command.type };
      case "plugins.workflow.start": {
        const run = EngineWorkflowRunSchema.parse(
          await manage("workflowRuns.start", {
            app: command.pluginId,
            workflow: command.workflow,
            input: command.input,
            key: createHash("sha256").update(creationKey).digest("hex"),
          }),
        );
        resourceChanged(command.pluginId, "workflowRuns");
        return { type: command.type, runId: run.id };
      }
      case "plugins.workflow.stop":
        await manage("workflowRuns.stop", { app: command.pluginId, run: command.runId });
        resourceChanged(command.pluginId, "workflowRuns");
        return { type: command.type };
      case "plugins.webhook.remove":
      case "plugins.webhook.removal.confirm":
        await manage(
          command.type === "plugins.webhook.remove" ? "webhooks.remove" : "webhooks.confirmRemoval",
          { app: command.pluginId, subscription: command.webhookId },
        );
        resourceChanged(command.pluginId, "webhooks");
        return { type: command.type };
      case "plugins.webhook.setup.complete":
        await manage("webhookSetup.complete", {
          app: command.pluginId,
          subscription: command.webhookId,
          revision: command.revision,
          state: command.state,
          ...(command.secret ? { secret: command.secret } : {}),
        });
        resourceChanged(command.pluginId, "webhooks");
        return { type: command.type };
    }
  }

  async #link(
    input: {
      pluginId: string;
      requirement: string;
      scope: "app" | "user";
      accountId: string;
      consent: PluginConsent;
    },
    userId: UserId,
    sessionId: string,
  ) {
    const consent = await this.#call(
      this.#options.service.linkAccount(
        {
          plugin: input.pluginId,
          requirement: input.requirement,
          scope: input.scope,
          account: input.accountId,
          consent: input.consent,
        },
        owner,
      ),
    );
    await this.#options.accountLinked({
      owner: userId,
      plugin: input.pluginId,
      requirement: input.requirement,
      scope: input.scope,
      consent: ConsentSchema.parse(consent),
      settlementSessionId: sessionId,
    });
  }
}

export function isPluginCommand(command: { type: string }): command is PluginCommand {
  return command.type.startsWith("plugins.");
}

function catalogEntry(entry: {
  id: string;
  name: string;
  description: string;
  category?: string | undefined;
  icons: unknown;
  auth: unknown[];
}) {
  return {
    id: entry.id.slice(0, 240),
    name: entry.name.slice(0, 240),
    description: clip(entry.description, 1_000),
    icon: pickIcon(entry.icons),
    auth: each(
      entry.auth,
      z.object({
        method: z.string().min(1),
        kind: z.enum(["secrets", "oauth2"]),
        label: z.string().optional(),
      }),
      8,
    ).map((auth) => ({
      method: auth.method.slice(0, 240),
      kind: auth.kind,
      label: (auth.label || (auth.kind === "secrets" ? "API key" : "Sign in")).slice(0, 240),
    })),
  };
}
