import { z } from "zod";
import { OpensteerError, type UserId } from "@opensteer/core";
import {
  PluginIconSchema,
  pluginReads,
  pluginRunsMax,
  pluginToolsMax,
  pluginVersionsMax,
  pluginsInstalledMax,
  rpcSuccess,
  type HostApiHandlers,
  type HostApiServerContext,
  type PluginCommand,
  type PluginCommandResult,
  type PluginEngineStateView,
  type InstalledPluginView,
  type PluginRequirementView,
  type PluginSummaryView,
} from "@opensteer/protocol";
import type { PluginAgentStore } from "@opensteer/database";
import { requireSession } from "../server/rpc-context.js";
import {
  PluginServiceError,
  type PluginCaller,
  type PluginConsent,
  type PluginJson,
} from "./engine-protocol.js";
import type { PluginService, PluginServiceState } from "./plugin-service.js";

/**
 * The person's own authority over their plugins. Every call acts as the
 * personal owner; no caller context ever comes from a client.
 */
const owner: PluginCaller = { caller: "personal", mode: "automatic" };

type Service = Pick<
  PluginService,
  | "state"
  | "installed"
  | "detail"
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
  readonly settings: Pick<
    PluginAgentStore,
    "settings" | "setAccess" | "recordInstall" | "recordActivation"
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
  /** Tells the owner's clients to reread what they show. */
  readonly changed: (owner: UserId) => void;
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
type Requirement = z.infer<typeof requirementSchema>;
function requirements(plugin: { requirements: { accounts: Record<string, unknown> } }) {
  return Object.entries(plugin.requirements.accounts).flatMap(([name, value]) => {
    const parsed = requirementSchema.safeParse(value);
    return parsed.success ? [[name, parsed.data] as const] : [];
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
  links: readonly { requirement: string; scope: string }[],
  row: Settings | undefined,
): PluginSummaryView {
  const required = requirements(plugin);
  const linked = required.filter(([name, r]) =>
    links.some((link) => link.requirement === name && link.scope === r.scope),
  );
  const missing = required.some(
    ([name, r]) => r.cardinality === "one" && !linked.some(([linkedName]) => linkedName === name),
  );
  return {
    id: plugin.id,
    name: plugin.name.slice(0, 240),
    slug: plugin.slug.slice(0, 240),
    icon: pickIcon(plugin.requirements.icons),
    author: authorOf(row, plugin.activeVersion),
    access: row?.access ?? "all",
    activeVersion: plugin.activeVersion,
    status: plugin.activeVersion === null ? "not-built" : missing ? "needs-account" : "ready",
    accounts: { required: required.length, linked: linked.length },
  };
}

function list(value: PluginJson | undefined, key?: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (key && value && typeof value === "object" && Array.isArray((value as never)[key]))
    return (value as Record<string, unknown[]>)[key]!;
  return [];
}
function each<T>(values: unknown[], schema: z.ZodType<T>, max: number): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (result.length >= max) break;
    const parsed = schema.safeParse(value);
    if (parsed.success) result.push(parsed.data);
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

const scheduleSchema = z.object({
  name: z.string().min(1),
  tool: z.string().min(1),
  timing: z.union([
    z.object({ kind: z.literal("interval"), milliseconds: z.number().int().positive() }),
    z.object({
      kind: z.literal("cron"),
      calendar: z.object({ expression: z.string(), timezone: z.string() }),
    }),
  ]),
  settings: z
    .object({
      id: z.string(),
      enabled: z.boolean(),
      approvalMode: z.enum(["automatic", "browser"]),
      nextAt: z.unknown(),
      activeRun: z.string().nullable(),
      accountRequired: z.string().optional(),
    })
    .nullable(),
});
const webhookSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["pending", "setup-required", "active", "stopping", "disabled", "stopped"]),
  failure: z.enum(["register", "unregister"]).nullable(),
  sourceAccount: z.string().min(1),
  callbackUrl: z.string(),
  createdAt: z.unknown(),
});
const webhookView = (w: z.infer<typeof webhookSchema>) => ({
  id: w.id,
  name: w.name.slice(0, 240),
  status: w.status,
  failure: w.failure,
  account: w.sourceAccount,
  createdAt: iso(w.createdAt),
});
const workflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.json()),
});
const scheduledRunSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: pluginReads["plugins.schedule.runs"].output.shape.runs.element.shape.status,
  scheduledAt: z.unknown(),
  finishedAt: z.unknown(),
  expiresAt: z.unknown(),
  failure: z.string().nullable(),
});
const workflowRunSchema = z.object({
  id: z.string().min(1),
  workflow: z.string().min(1),
  status: pluginReads["plugins.workflow.runs"].output.shape.runs.element.shape.status,
  createdAt: z.string(),
  failure: z.object({ message: z.string().optional() }).optional(),
  error: z.string().optional(),
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
      message: error.message.slice(0, 1_000) || "The plugin engine refused this.",
      reason:
        error.code === "unavailable"
          ? "plugin-engine-unavailable"
          : error.code === "consent-changed"
            ? "plugin-consent-changed"
            : `plugin-${error.code}`,
    });
  }
  throw error;
}

export class PluginOwnerApi {
  readonly #options: PluginOwnerApiOptions;
  /** Retried commands from a weak connection resolve to the first attempt's result. */
  readonly #recent = new Map<string, Promise<PluginCommandResult>>();
  constructor(options: PluginOwnerApiOptions) {
    this.#options = options;
  }

  async #owner(context: HostApiServerContext) {
    const session = requireSession(context);
    await this.#options.assertOwner(session.user.id);
    return session;
  }
  async #settings(userId: UserId) {
    return each(
      await this.#options.settings.settings(userId),
      settingsRow,
      pluginsInstalledMax * 4,
    );
  }
  #call<T>(promise: Promise<T>): Promise<T> {
    return promise.catch(hostError);
  }

  async installed(userId: UserId, signal?: AbortSignal) {
    const [rows, settings] = await Promise.all([
      this.#call(this.#options.service.installed({}, owner, signal)),
      this.#settings(userId),
    ]);
    return {
      engine: pluginEngineStateView(this.#options.service.state()),
      plugins: rows
        .slice(0, pluginsInstalledMax)
        .map(({ plugin, links }) =>
          summary(
            plugin,
            links,
            settings.find((row) => row.pluginId === plugin.id),
          ),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async detail(userId: UserId, pluginId: string, signal?: AbortSignal) {
    const service = this.#options.service;
    const [detail, settings, accounts] = await Promise.all([
      this.#call(service.detail({ plugin: pluginId }, owner, signal)),
      this.#settings(userId),
      this.#call(service.accounts({}, owner, signal)),
    ]);
    const row = settings.find((entry) => entry.pluginId === pluginId);
    const plugin = detail.plugin;
    const links = each(
      detail.links,
      z.object({
        requirement: z.string(),
        scope: z.string(),
        account: z.string(),
        consent: z.object({ digest: z.string() }),
      }),
      500,
    );
    const requirementViews: PluginRequirementView[] = await Promise.all(
      requirements(plugin)
        .slice(0, 50)
        .map(async ([name, r]: readonly [string, Requirement]) => {
          const consent = plugin.activeVersion
            ? await service
                .reviewAccountLink(
                  { plugin: pluginId, requirement: name, scope: r.scope },
                  owner,
                  signal,
                )
                .catch(() => null)
            : null;
          return {
            name,
            scope: r.scope,
            provider: r.provider,
            providerName: r.definition.name.slice(0, 240),
            cardinality: r.cardinality,
            consent,
            links: links
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
                  current: consent !== null && consent.digest === link.consent.digest,
                };
              }),
          };
        }),
    );
    const tools = detail.tools
      ? each(
          detail.tools.items,
          z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            readOnly: z.boolean().optional(),
          }),
          pluginToolsMax,
        ).map((tool) => ({
          name: tool.name.slice(0, 240),
          description: (tool.description ?? "").slice(0, 2_000),
          readOnly: tool.readOnly === true,
        }))
      : null;
    const skills =
      detail.skills === null
        ? null
        : each(
            list(detail.skills, "skills"),
            z.object({ name: z.string().min(1), description: z.string().optional() }),
            100,
          ).map((skill) => ({
            name: skill.name.slice(0, 240),
            description: (skill.description ?? "").slice(0, 2_000),
          }));
    const view: InstalledPluginView = {
      plugin: summary(plugin, links, row),
      requirements: requirementViews,
      tools,
      toolCount: detail.tools?.items.length ?? 0,
      skills,
      versions: each(
        list(detail.versions),
        z.object({ id: z.string().min(1), createdAt: z.unknown() }),
        500,
      )
        .sort((a, b) => (iso(b.createdAt) ?? "").localeCompare(iso(a.createdAt) ?? ""))
        .slice(0, pluginVersionsMax)
        .map((version) => ({
          id: version.id,
          createdAt: iso(version.createdAt),
          active: version.id === plugin.activeVersion,
          author: authorOf(row, version.id),
        })),
      schedules: each(list(detail.schedules), scheduleSchema, 50).map((schedule) => ({
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
          : each(list(detail.workflows), workflowSchema, 50).map((workflow) => ({
              name: workflow.name.slice(0, 240),
              description: workflow.description?.slice(0, 2_000) ?? null,
              inputSchema: workflow.inputSchema,
            })),
      webhooks: each(list(detail.webhooks), webhookSchema, 50).map(webhookView),
      page: detail.hasPage
        ? {
            url: null,
            unavailable: "Plugin pages can't be opened from Opensteer yet.",
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
    const [consent, detail, accounts, settings] = await Promise.all([
      this.#call(service.reviewAccountLink(target, owner, signal)),
      this.#call(service.detail({ plugin: input.pluginId }, owner, signal)),
      this.#call(service.accounts({}, owner, signal)),
      this.#settings(userId),
    ]);
    const requirement = requirements(detail.plugin).find(
      ([name, r]) => name === input.requirement && r.scope === input.scope,
    )?.[1];
    if (!requirement)
      throw new OpensteerError({
        code: "conflict",
        reason: "plugin-consent-changed",
        message: "This plugin no longer asks for that account.",
      });
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
      "plugins.installed.list": async (_input, context) => {
        const session = await this.#owner(context);
        return rpcSuccess(await this.installed(session.user.id));
      },
      "plugins.get": async (input, context) => {
        const session = await this.#owner(context);
        return rpcSuccess(await this.detail(session.user.id, input.pluginId));
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
        const accounts = await this.#call(service.accounts({}, owner));
        return rpcSuccess({
          accounts: accounts.slice(0, 500).map((account) => ({
            id: account.id,
            provider: account.provider,
            label: account.label.slice(0, 240),
          })),
        });
      },
      "plugins.account.review": async (input, context) => {
        const session = await this.#owner(context);
        return rpcSuccess(await this.review(input, session.user.id));
      },
      "plugins.schedule.runs": async (input, context) => {
        await this.#owner(context);
        const runs = each(
          list(
            await this.#call(
              service.manage(
                {
                  operation: "schedules.runs",
                  input: { app: input.pluginId, ...(input.pending ? { pending: true } : {}) },
                },
                owner,
              ),
            ),
          ),
          scheduledRunSchema,
          pluginRunsMax,
        );
        return rpcSuccess({
          runs: await Promise.all(
            runs.map(async (run) => {
              let approval = null;
              if (run.status === "awaiting-approval") {
                const pending = z
                  .object({ invocation: z.object({ tool: z.string().min(1), input: z.json() }) })
                  .safeParse(
                    await service
                      .manage({ operation: "schedules.approval", input: { run: run.id } }, owner)
                      .catch(() => null),
                  );
                if (pending.success)
                  approval = {
                    tool: pending.data.invocation.tool.slice(0, 240),
                    arguments: pending.data.invocation.input,
                  };
              }
              return {
                id: run.id,
                schedule: run.name.slice(0, 240) || run.id,
                status: run.status,
                scheduledAt: iso(run.scheduledAt),
                finishedAt: iso(run.finishedAt),
                expiresAt: iso(run.expiresAt),
                failure: run.failure?.slice(0, 1_000) ?? null,
                approval,
              };
            }),
          ),
        });
      },
      "plugins.workflow.runs": async (input, context) => {
        await this.#owner(context);
        const page = z
          .object({ items: z.array(z.unknown()), next: z.string().optional() })
          .catch({ items: [] })
          .parse(
            await this.#call(
              service.manage(
                {
                  operation: "workflowRuns.list",
                  input: {
                    app: input.pluginId,
                    limit: String(pluginRunsMax),
                    ...(input.workflow ? { workflow: input.workflow } : {}),
                    ...(input.cursor ? { cursor: input.cursor } : {}),
                  },
                },
                owner,
              ),
            ),
          );
        return rpcSuccess({
          runs: each(page.items, workflowRunSchema, pluginRunsMax).map((run) => ({
            id: run.id,
            workflow: run.workflow.slice(0, 240),
            status: run.status,
            createdAt: run.createdAt.slice(0, 64),
            failure: (run.failure?.message ?? run.error ?? null)?.slice(0, 1_000) ?? null,
          })),
          cursor: page.next && page.next.length <= 512 ? page.next : null,
        });
      },
      "plugins.webhook.setup.get": async (input, context) => {
        await this.#owner(context);
        const setup = z
          .object({
            step: z.enum(["configure", "remove", "done"]),
            subscription: webhookSchema,
            instructions: z.string().optional(),
            revision: z.string().optional(),
            stateSchema: z.record(z.string(), z.json()).optional(),
            signingSecret: z
              .object({ source: z.string(), value: z.string().optional() })
              .optional(),
          })
          .parse(
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
          step: setup.step,
          webhook: webhookView(setup.subscription),
          callbackUrl: setup.subscription.callbackUrl.slice(0, 2_048),
          instructions: setup.instructions?.slice(0, 8_000) ?? null,
          revision: setup.revision?.slice(0, 200) ?? null,
          stateSchema: setup.stateSchema ?? null,
          signingSecret: setup.signingSecret?.value?.slice(0, 1_000) ?? null,
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
    const changed = () => this.#options.changed(userId);
    const manage = (operation: Parameters<Service["manage"]>[0]["operation"], input: object) =>
      this.#call(service.manage({ operation, input: input as Record<string, PluginJson> }, owner));
    switch (command.type) {
      case "plugins.install": {
        const source = command.source;
        const result = await this.#call(
          service.install(
            source.kind === "catalog"
              ? { kind: "catalog", id: source.catalogId }
              : { kind: source.kind, url: source.url, name: source.name },
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
          source.kind === "catalog" ? "catalog" : "agent",
        );
        changed();
        return {
          type: command.type,
          result: { status: "installed", pluginId: result.plugin.id, versionId: result.version.id },
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
        changed();
        return { type: command.type };
      case "plugins.access.set":
        await settings.setAccess(userId, command.pluginId, command.access);
        changed();
        return { type: command.type, access: command.access };
      case "plugins.account.create": {
        const account = await this.#call(
          service.createApiKeyAccount(
            {
              provider: command.provider,
              method: command.method,
              fields: command.fields,
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
      case "plugins.account.remove":
        await this.#call(service.removeAccount({ account: command.accountId }, owner));
        changed();
        return { type: command.type };
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
        changed();
        return { type: command.type };
      case "plugins.schedule.configure":
        await manage("schedules.configure", {
          app: command.pluginId,
          name: command.schedule,
          enabled: command.enabled,
          ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
        });
        changed();
        return { type: command.type };
      case "plugins.schedule.answer":
        await manage("schedules.answer", { run: command.runId, action: command.action });
        changed();
        return { type: command.type };
      case "plugins.workflow.start": {
        const run = z.object({ id: z.string().min(1).max(240) }).parse(
          await manage("workflowRuns.start", {
            app: command.pluginId,
            workflow: command.workflow,
            input: command.input,
            key: command.idempotencyKey,
          }),
        );
        return { type: command.type, runId: run.id };
      }
      case "plugins.workflow.stop":
        await manage("workflowRuns.stop", { app: command.pluginId, run: command.runId });
        return { type: command.type };
      case "plugins.webhook.setup.complete":
        await manage("webhookSetup.complete", {
          app: command.pluginId,
          subscription: command.webhookId,
          revision: command.revision,
          state: command.state,
          ...(command.secret ? { secret: command.secret } : {}),
        });
        changed();
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
      consent: z
        .object({
          digest: z.string(),
          sites: z.array(z.string()),
          credential: z.enum(["sealed", "value"]),
        })
        .catch(input.consent)
        .parse(consent),
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
    category: entry.category?.slice(0, 80) || null,
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
