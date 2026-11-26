import { grantHolds, pluginCaller, pluginGrantTarget } from "../../plugins/plugin-authority.js";
import { pluginTargetBlocked } from "../../plugins/target-blocked.js";
import { requestResult } from "../request-result.js";
import { requestPendingGuidance } from "@opensteer/shared/requestGuidance";
import type { PluginCaller } from "../../plugins/engine-protocol.js";
import { z } from "zod";
import {
  agentGrantAccess,
  AgentOperationIdSchema,
  agentOperationHoldMs,
  OpensteerError,
  type ThreadAccessMode,
  type ThreadId,
  requestOperationCallsMaxLength,
  threadAccessModeAtMost,
  ToolBlockedError,
  type Blocked,
  type UserId,
} from "@opensteer/core";
import type { PluginChange, PluginResourceCategory } from "@opensteer/protocol";
import type { OpensteerStore, PluginAgentStore } from "@opensteer/database";
import type { AgentToolHandlers, ToolCall } from "./types.js";
import { requireRun } from "../operations.js";
import {
  callerLineage,
  callerThread,
  type AgentCaller,
  type ConnectionCaller,
} from "../agent-caller.js";
import type { PluginService } from "../../plugins/plugin-service.js";
import type { PluginAuthority } from "../../plugins/plugin-authority.js";
import { pluginInputNext, type PluginExecutions } from "../../plugins/plugin-executions.js";
import type { LocalProviders } from "../../plugins/local-providers.js";
import {
  operations,
  PluginServiceError,
  type PluginConsent,
  type PluginInput,
} from "../../plugins/engine-protocol.js";
import { keysetPage } from "../../plugins/keyset-page.js";
import { engineInstallReceipt } from "../../plugins/engine-storage.js";
import { localNamespace, localToolPath, pluginNamespace } from "../../plugins/provider-names.js";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { delay } from "@opensteer/shared/delay";
import { directResult, requireDirectWork } from "./direct.js";
import type { AgentSessionService } from "../../agent-sessions/agent-session-service.js";
import { forgetLent } from "../lent-now.js";

const owner = { caller: "personal", mode: "automatic" } as const;

/** The catalog's feed could not be read; a later call may list it. */
export const catalogUnavailable: Blocked = {
  code: "catalog_unavailable",
  message: "The plugin catalog can't be reached right now.",
  next: "Retry opensteer_plugin_catalog in a few minutes. Installed plugins still work (opensteer_plugin_list).",
};

export class PluginToolHandlers {
  readonly options: {
    service: PluginService;
    /** Device data apps and local servers, which list beside plugins. */
    localProviders?: Pick<LocalProviders, "providers">;
    authority: PluginAuthority;
    executions: PluginExecutions;
    sessions?: () => AgentSessionService;
    store: OpensteerStore;
    settings: PluginAgentStore;
    folder: (
      caller: AgentCaller,
      directory: string,
    ) => Promise<Extract<PluginInput<"install">, { kind: "files" }>>;
    exportFiles: (
      caller: AgentCaller,
      directory: string,
      files: PluginInput<"install"> & { kind: "files" },
      authorize: () => Promise<void>,
      signal?: AbortSignal,
    ) => Promise<void>;
    /** Tells the owner's clients their plugins changed. */
    changed?: (owner: UserId, change?: PluginChange) => void;
    removed?: (plugin: string) => void;
  };
  constructor(options: PluginToolHandlers["options"]) {
    this.options = options;
  }
  /**
   * What an agent sees of its plugins, small enough for its context with many installed: plugins
   * and local tools (device data apps and local servers, counted; plugin_search finds their tools)
   * in one list a page at a time, plugins with their newest versions, and one plugin with every
   * kept version when it asks by id. A local server waiting for its first approved launch has no
   * tools yet; this list is where it appears, blocked with why.
   */
  async list(c: ToolCall<"opensteer_plugin_list">) {
    const caller = c.caller;
    const context = this.options.authority.admit(caller);
    const settings = await this.options.settings.settings(caller.userId);
    // Local providers are listed independently of the installed plugin engine.
    // It may read the grant itself: it only decides whether to ask the engine for installed
    // plugins, and names no device and no approval.
    const listInstalled =
      caller.kind !== "connection" ||
      caller.grant.scope === "everything" ||
      caller.grant.resources.some(
        (resource) => resource.kind === "plugin" && resource.target.kind === "installed",
      );
    const broadDiscovery = c.discoveryInput !== undefined && c.discoveryInput.id === undefined;
    let pluginsUnavailable =
      listInstalled && broadDiscovery && this.options.service.state().status === "unavailable";
    const onEngineUnavailable = (error: unknown) => {
      if (
        !broadDiscovery ||
        !(error instanceof PluginServiceError) ||
        (error.code !== "unavailable" && error.code !== "interrupted")
      )
        throw error;
      pluginsUnavailable = true;
      return [];
    };
    const [plugins, local] = await Promise.all([
      !listInstalled || pluginsUnavailable
        ? []
        : this.options.service.list({}, context, c.signal).catch(onEngineUnavailable),
      c.input.pluginId ? [] : (this.options.localProviders?.providers(context) ?? []),
    ]);
    const access = (id: string) => {
      const configured = settings.find((s) => s.pluginId === id)?.access ?? "all";
      if (caller.kind !== "connection" || configured === "off") return configured;
      const granted = agentGrantAccess(caller.grant, {
        kind: "plugin",
        target: pluginGrantTarget(id),
      });
      return !granted ? "off" : granted === "read" ? "read-only" : configured;
    };
    const entries = [
      ...plugins
        .filter(({ id }) => caller.kind !== "connection" || access(id) !== "off")
        .map((plugin) => ({ kind: "plugin" as const, id: plugin.id })),
      ...local
        .filter(({ id }) => access(id) !== "off")
        .map((provider) => ({ kind: "local" as const, id: provider.id })),
    ];
    const page = c.input.pluginId
      ? { items: entries.filter(({ id }) => id === c.input.pluginId), cursor: null }
      : // By id, which never changes: a device renamed between pages moves its slug, not its place.
        keysetPage(entries, (entry) => entry.id, {
          scope: "agent-plugins/id",
          cursor: c.input.cursor,
          max: 25,
        });
    const pagePlugins = page.items.filter(({ kind }) => kind === "plugin");
    const installed = pagePlugins.length
      ? await this.options.service
          .installed({ plugins: pagePlugins.map(({ id }) => id), versions: true }, owner, c.signal)
          .catch(onEngineUnavailable)
      : [];
    let versionCursor: string | null = null;
    return {
      // An agent sees one list: local tools are addressed as tools.<slug> like plugins.
      local: page.items.flatMap(({ kind, id }) => {
        const provider = kind === "local" ? local.find((entry) => entry.id === id) : undefined;
        if (!provider) return [];
        return [
          {
            id: provider.id,
            name: provider.name,
            slug: provider.slug,
            access: access(provider.id) as "all" | "read-only",
            status: provider.blocked ? ("unavailable" as const) : ("active" as const),
            ...(provider.blocked ? { blocked: provider.blocked } : {}),
            toolCount: provider.tools.length,
            readOnlyToolCount: provider.tools.filter(({ readOnly }) => readOnly === true).length,
          },
        ];
      }),
      plugins: await Promise.all(
        pagePlugins
          .flatMap(({ id }) => installed.find(({ plugin }) => plugin.id === id) ?? [])
          .map(async (detail) => {
            const { plugin } = detail;
            const versionPage = c.input.pluginId
              ? await this.options.service.detailSection(
                  {
                    plugin: plugin.id,
                    section: "versions",
                    ...(c.input.cursor ? { cursor: c.input.cursor } : {}),
                  },
                  { caller: "personal", mode: "automatic" },
                  c.signal,
                )
              : undefined;
            if (versionPage) versionCursor = versionPage.cursor;
            const versions = z
              .array(z.object({ id: z.string().min(1), createdAt: z.string() }).passthrough())
              .catch([])
              .parse(versionPage?.items ?? detail.versions)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            const needsAccount = Object.values(detail.readiness).some(
              ({ state }) => state !== "usable",
            );
            const blocked = !plugin.activeVersion
              ? {
                  code: "unavailable",
                  message: `${plugin.name} has no active version.`,
                  next: "The person can choose an active version in Plugins; continue without it until then.",
                }
              : needsAccount
                ? pluginTargetBlocked({
                    id: plugin.id,
                    name: plugin.name,
                    reason: `${plugin.name} needs account setup.`,
                    requirements: plugin.requirements.accounts,
                    readiness: detail.readiness,
                    canRequestAccount: c.caller.kind === "run" || c.caller.kind === "program",
                    connection: c.caller.kind === "connection",
                  })
                : undefined;
            return {
              ...(blocked ? { blocked } : {}),
              id: plugin.id,
              name: plugin.name,
              slug: plugin.slug,
              activeVersion: plugin.activeVersion,
              versions: versions.slice(0, c.input.pluginId ? 200 : 10).map((version) => ({
                id: version.id,
                active: version.id === plugin.activeVersion,
              })),
              versionCount: detail.versionCount ?? versions.length,
              requirements: Object.fromEntries(
                Object.entries(detail.plugin.requirements.accounts).map(([name, r]) => [
                  name,
                  { scope: r.scope, provider: r.provider },
                ]),
              ),
              access: access(plugin.id) as "all" | "read-only",
              links: detail.links
                .slice(0, 100)
                .map(({ requirement, scope, account }) => ({ requirement, scope, account })),
              status: blocked ? "unavailable" : "active",
            };
          }),
      ),
      cursor: c.input.pluginId ? versionCursor : page.cursor,
      ...(pluginsUnavailable ? { pluginsUnavailable: true as const } : {}),
    };
  }
  async discoveryResult<
    T extends {
      unavailableApps?:
        | readonly { app: string; name: string; reason: string; blocked?: Blocked | undefined }[]
        | undefined;
    },
  >(context: PluginCaller, found: T) {
    // Under a connection's grant, what the grant does not hold (`access_required`: a write it
    // holds for reading only, an app it does not reach) is not there: plugin_call reads it as
    // absent, and so does every listing.
    const caller = this.options.authority.caller(context.caller);
    const result =
      caller && callerLineage(caller) && "items" in found && Array.isArray(found.items)
        ? {
            ...found,
            items: (found.items as { blocked?: Blocked }[]).filter(
              ({ blocked }) => blocked?.code !== "access_required",
            ),
          }
        : found;
    const unavailable = result.unavailableApps;
    if (!unavailable?.length) return result;
    const remoteIds = [...new Set(unavailable.filter((e) => !e.blocked).map((e) => e.app))];
    const installed = remoteIds.length
      ? await this.options.service.installed({ plugins: remoteIds }, owner).catch(() => [])
      : [];
    return {
      ...result,
      unavailableApps: unavailable.map((entry) => {
        if (entry.blocked) return entry;
        const detail = installed.find(({ plugin }) => plugin.id === entry.app);
        return {
          ...entry,
          blocked: pluginTargetBlocked({
            id: entry.app,
            name: entry.name,
            reason: entry.reason,
            canRequestAccount:
              this.options.authority.caller(context.caller)?.kind === "run" ||
              this.options.authority.caller(context.caller)?.kind === "program",
            connection: this.options.authority.caller(context.caller)?.kind === "connection",
            requirements: detail?.plugin.requirements.accounts ?? {},
            readiness: detail?.readiness ?? {},
          }),
        };
      }),
    };
  }
  async #directExecution(
    caller: ConnectionCaller,
    call: ToolCall<"plugin_call"> | ToolCall<"plugin_execute"> | ToolCall<"plugin_resume">,
  ) {
    const o = this.options;
    const sessions = requireDirectWork(o.sessions?.());
    const context = o.authority.admit(caller);
    const unavailable = () =>
      new OpensteerError({
        code: "forbidden",
        message: "Plugin tool is unavailable to this caller.",
      });
    const { taskId, reason } = call.input;
    const signal = call.signal;
    // What this connection's grant and the person's plugin setting let it do in an app: the one
    // gate every call here passes, whether the app can be reached now or not.
    const holds = async (plugin: string, write: boolean) => {
      if (!grantHolds(caller.grant, plugin, write)) return false;
      const setting = (await o.settings.settings(caller.userId)).find(
        ({ pluginId }) => pluginId === plugin,
      )?.access;
      return setting !== "off" && !(write && setting === "read-only");
    };
    let target: { plugin: string; name: string; version: string; readOnly: boolean };
    let tool: "plugin_call" | "plugin_execute" | "plugin_resume";
    let input: { calls: PluginInput<"call">["calls"] } | { code: string } | { executionId: string };
    let calls: string;
    const providers = async () => {
      const [installed, local] = await Promise.all([
        o.service.list({}, context, signal),
        o.localProviders?.providers(context) ?? [],
      ]);
      return [
        ...installed.map((item) => ({ ...item, version: item.activeVersion })),
        ...local.map((item) => ({ ...item, slug: localNamespace(item.slug, item.id) })),
      ];
    };
    let continuationWrites = false;
    let continuationMode: ThreadAccessMode | null = null;
    let continuation:
      | {
          taskId: ThreadId;
          row: Awaited<ReturnType<PluginExecutions["sessionExecution"]>>;
        }
      | undefined;
    if ("calls" in call.input) {
      tool = "plugin_call";
      input = { calls: call.input.calls };
      calls = canonicalJson(input);
      const paths = (Array.isArray(input.calls) ? input.calls : [input.calls]).map(
        ({ path }) => path,
      );
      // The engine alone reads which tool each path names, with its own parser and escaping; a
      // tool that is there but blocked comes with its reason.
      const resolved = await o.service.resolveTools({ paths }, context, signal);
      // A blocked tool this call's own grant holds (its level, the person's plugin setting, read
      // against write, for the tool the engine named) says why: never that it does not exist,
      // and never a Request for what cannot run. One it does not hold, or one the grant does not
      // reach (`access_required`), reads exactly as absent, as anything outside a grant.
      for (const entry of resolved)
        if (
          entry?.blocked &&
          entry.blocked.code !== "access_required" &&
          (await holds(entry.plugin, !entry.readOnly))
        )
          throw new ToolBlockedError(entry.blocked);
      const first = resolved[0];
      if (
        !first ||
        resolved.length !== paths.length ||
        resolved.some((entry) => !entry || entry.blocked)
      ) {
        throw unavailable();
      }
      if (
        resolved.some((entry) => entry?.plugin !== first.plugin || entry.version !== first.version)
      )
        throw new OpensteerError({
          code: "bad_request",
          message: "Call one plugin per operation.",
        });
      target = { ...first, readOnly: resolved.every((entry) => entry?.readOnly) };
    } else if ("code" in call.input) {
      // A program is not refused before it runs for a blocked tool inside it: its Request, when
      // the mode asks one, is for running the program, whose calls are known only as it runs. A
      // blocked tool it calls fails with its own reason, from the same function as plugin_call's,
      // without reaching the device.
      tool = "plugin_execute";
      input = { code: call.input.code };
      calls = input.code;
      const namespace = call.input.namespace;
      if (!namespace)
        throw new OpensteerError({
          code: "bad_request",
          message: "Supply the one plugin namespace from discover.",
        });
      const matches = (await providers()).filter((item) => localToolPath(item.slug) === namespace);
      const provider = matches[0];
      if (matches.length !== 1 || !provider?.version) throw unavailable();
      target = {
        plugin: provider.id,
        name: provider.name,
        version: provider.version,
        readOnly: false,
      };
    } else {
      tool = "plugin_resume";
      if (!taskId)
        throw new OpensteerError({
          code: "bad_request",
          message: "Supply the taskId that started this plugin execution.",
        });
      input = { executionId: call.input.executionId };
      calls = canonicalJson(input);
      const row = await o.executions.sessionExecution(caller, input.executionId, taskId);
      const origin = AgentOperationIdSchema.safeParse(
        row.caller.slice(row.caller.lastIndexOf(":") + 1),
      );
      if (!origin.success) throw unavailable();
      const receipt = await o.store.database
        .selectFrom("agentOperations")
        .select(["targetGeneration", "target", "effect"])
        .where("id", "=", origin.data)
        .where("sessionId", "=", row.agentSessionId)
        .where("state", "=", "completed")
        .executeTakeFirst();
      if (!receipt?.targetGeneration || receipt.target.grant.kind !== "plugin") throw unavailable();
      const originTarget = canonicalJson(receipt.target.grant.target);
      const provider = (await providers()).find(
        (item) => canonicalJson(pluginGrantTarget(item.id)) === originTarget,
      );
      if (provider?.version !== receipt.targetGeneration) throw unavailable();
      continuation = { taskId, row };
      continuationWrites = receipt.effect === "write";
      continuationMode = row.admittedAccessMode;
      target = {
        plugin: provider.id,
        name: provider.name,
        version: provider.version,
        readOnly: true,
      };
    }
    if (calls.length > requestOperationCallsMaxLength)
      throw new OpensteerError({
        code: "bad_request",
        message: `Use at most ${requestOperationCallsMaxLength.toLocaleString("en-US")} characters per connected plugin operation.`,
      });
    const grant = { kind: "plugin", target: pluginGrantTarget(target.plugin) } as const;
    if (!(await holds(target.plugin, !target.readOnly || continuationWrites))) throw unavailable();
    if (continuation) {
      const { taskId } = continuation;
      let { row } = continuation;
      const deadline = Date.now() + agentOperationHoldMs;
      while ((row.state === "waiting" || row.state === "answered") && row.requestId) {
        signal?.throwIfAborted();
        const request = await o.store.requests.get(row.requestId);
        if (request?.status !== "pending") break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const live = await o.store.admitExecution({
            ownerUserId: caller.userId,
            subject: { kind: "binding", bindingId: `session:${row.agentSessionId}` },
          });
          if (
            live.agentConnection?.grantRevision !== caller.grantRevision ||
            (continuationMode && !threadAccessModeAtMost(continuationMode, live.mode))
          )
            throw unavailable();
          return {
            status: "pending",
            taskId,
            executionId: row.id,
            requestId: row.requestId,
            next: pluginInputNext(row.id, taskId),
          };
        }
        await delay(Math.min(remaining, 500), signal);
        row = await o.executions.sessionExecution(caller, row.id, taskId);
      }
    }
    const outcome = await sessions.run({
      ownerUserId: caller.userId,
      agentConnectionId: caller.connectionId,
      taskId,
      reason,
      operationKey: call.operationKey,
      tool,
      input: call.input,
      target: { grant, name: target.name.slice(0, 255), device: null },
      targetGeneration: target.version,
      effect: target.readOnly ? "read" : "write",
      calls,
      execute: async (operation) => {
        await operation.recheck();
        // It waited for the person: what is lent is read again, not kept from before the wait, and
        // an app that is no longer there reads as one that never was (rule 5), before anything runs.
        if (operation.requestId) {
          forgetLent(caller);
          if (
            !(await providers()).some(
              (item) => item.id === target.plugin && item.version === target.version,
            )
          )
            throw unavailable();
        }
        if (continuationMode && !threadAccessModeAtMost(continuationMode, operation.mode))
          throw unavailable();
        if ("executionId" in input)
          return o.executions.resumeSession(
            caller,
            input.executionId,
            operation.taskId,
            operation.signal,
          );
        return o.authority.scoped(
          caller,
          () =>
            o.executions.execute(
              caller,
              "calls" in input ? "call" : "execute",
              input,
              operation.signal,
            ),
          {
            operation,
            plugin: target.plugin,
            version: target.version,
            write: !target.readOnly,
            program: "code" in input,
          },
        );
      },
      summarize: (result) => ({ executionId: result.executionId, status: result.status }),
      replay: async (row, authority) => {
        if (
          row.grantRevision !== caller.grantRevision ||
          row.targetGeneration !== target.version ||
          !threadAccessModeAtMost(row.mode, authority.mode)
        )
          throw unavailable();
        if (continuationMode && !threadAccessModeAtMost(continuationMode, authority.mode))
          throw unavailable();
        const id = row.resultSummary?.executionId;
        if (typeof id !== "string" || !authority.threadId) return undefined;
        const saved = await o.executions.sessionExecution(caller, id, authority.threadId);
        return o.executions.terminalResult(caller, saved, signal);
      },
    });
    const result = directResult(outcome);
    if (outcome.status === "pending")
      return {
        ...result,
        next: `Waiting for the person's approval in Needs you. Call ${tool} again with the same arguments and the returned operationId to wait up to ${agentOperationHoldMs / 1_000} seconds. Avoid polling in a tight loop.`,
      };
    if (outcome.status === "completed" && outcome.result) {
      const { status, executionId } = outcome.result;
      const { operationId, ...execution } = result;
      return {
        ...execution,
        ...(tool === "plugin_resume" && status === "pending" ? {} : { operationId }),
        status,
        ...(status === "pending" ? { next: pluginInputNext(executionId, outcome.taskId) } : {}),
      };
    }
    return result;
  }
  async install(c: ToolCall<"opensteer_plugin_install">) {
    const context = this.options.authority.admit(c.caller);
    await this.options.authority.assert(context, "install", c.input.pluginId);
    const i = c.input;
    const key = JSON.stringify([
      c.caller.userId,
      c.caller.key,
      "opensteer_plugin_install",
      c.operationKey,
    ]);
    // A repeat answers from its receipt before the folder is read, so a moved draft cannot hide it.
    const receipt =
      i.source === "folder" ? await engineInstallReceipt(this.options.store.database, key) : null;
    const result = receipt
      ? installedView(operations.install.output.parse(receipt))
      : await this.#install(c, context, key);
    // The version's author was recorded when it became active; a replay changes no author. It
    // repairs the skill record, which follows the active version however this install ended.
    if (receipt && result.status === "installed")
      await this.options.service.reconcileSkills([result.plugin.id]);
    if (result.status === "installed") this.options.changed?.(c.caller.userId);
    return {
      ...result,
      ...(result.status === "build-error"
        ? {
            next: "Fix the reported source/build errors in the draft folder and call opensteer_plugin_install again. No new version became active.",
          }
        : {}),
    };
  }
  async #install(
    c: ToolCall<"opensteer_plugin_install">,
    context: ReturnType<PluginAuthority["admit"]>,
    key: string,
  ) {
    const i = c.input;
    const input = operations.install.input.parse({
      ...(i.source === "folder"
        ? {
            ...(await this.options.folder(c.caller, z.string().min(1).parse(i.directory))),
            ...(i.pluginId ? { plugin: i.pluginId } : {}),
            ...(i.name ? { name: i.name } : {}),
          }
        : i.source === "catalog"
          ? { kind: "catalog", id: i.catalogId }
          : { kind: i.source, url: i.url, name: i.name }),
      key,
    });
    await c.checkLive?.();
    return this.options.service.install(input, context, c.signal);
  }
  async export(c: ToolCall<"opensteer_plugin_export">) {
    const context = this.options.authority.admit(c.caller);
    const files = await this.options.service.export(
      { plugin: c.input.pluginId, ...(c.input.versionId ? { version: c.input.versionId } : {}) },
      context,
      c.signal,
    );
    await this.options.exportFiles(
      c.caller,
      c.input.directory,
      { kind: "files", files },
      async () => {
        await c.checkLive?.();
        await this.options.authority.assert(context, "export", c.input.pluginId);
      },
      c.signal,
    );
    return {
      directory: c.input.directory,
      files: files.length,
      next: `Edit the draft, then call opensteer_plugin_install with source:folder and pluginId:${c.input.pluginId}.`,
    };
  }
  async #accountRequest(c: ToolCall<"plugin_account_request">) {
    const caller = c.caller.kind === "connection" ? requireRun(c.caller) : c.caller;
    const context = this.options.authority.admit(caller);
    await this.options.authority.assert(context, "account-request", c.input.pluginId);
    const target = {
      plugin: c.input.pluginId,
      requirement: c.input.requirement,
      scope: c.input.scope,
    };
    const [detail] = await this.options.service.installed(
      { plugins: [target.plugin] },
      owner,
      c.signal,
    );
    const consent = detail?.readiness[target.requirement]?.consent;
    if (
      !detail ||
      !consent ||
      detail.plugin.requirements.accounts[target.requirement]?.scope !== target.scope
    )
      throw new OpensteerError({
        code: "conflict",
        message: "The plugin account requirement is unavailable.",
      });
    const version = detail.plugin.activeVersion;
    const author =
      (version
        ? (
            await this.options.settings.versionAuthors(caller.userId, [
              { pluginId: target.plugin, version },
            ])
          ).get(`${target.plugin}\u0000${version}`)
        : undefined) ?? "agent";
    await this.options.authority.assert(context, "account-request", target.plugin);
    const origin =
      caller.kind === "run"
        ? ({ originatingRunId: caller.claims.runId } as const)
        : caller.program.kind === "trigger"
          ? ({ originatingOccurrenceId: caller.program.occurrenceId } as const)
          : ({ originatingWatchActivationId: caller.program.activationId } as const);
    const created = await this.options.store.requests.create({
      callId: `plugin-account:${c.operationKey}`,
      kind: "plugin.account",
      mode: "durable",
      ...origin,
      originatingThreadId: callerThread(caller).id,
      requestedBy: caller.userId,
      requiredActor: "owner",
      payload: { kind: "plugin.account", ...target, consent },
      presentation: {
        kind: "external",
        title: `Connect ${detail.plugin.name}`.slice(0, 240),
        detail: `${c.input.reason}\nLinking trusts this plugin's code. Setup runs with the account before tool approval.`,
        subject: { kind: "plugin.account", id: target.plugin },
        plugin: {
          plugin: { id: target.plugin, name: detail.plugin.name.slice(0, 240), author },
          decision: {
            kind: "account",
            requirement: target.requirement,
            scope: target.scope,
            consent,
          },
        },
      },
    });
    return requestResult(
      created.request,
      created.request.status === "pending"
        ? requestPendingGuidance
        : created.request.status === "fulfilled"
          ? "The request was fulfilled. Use plugin_search to check the plugin's current tools."
          : "The request is closed. Continue without this account.",
      created.replayed,
    );
  }
  /** Called after a person-reviewed link commits, including an OAuth completion. */
  async accountLinked(input: {
    owner: UserId;
    plugin: string;
    requirement: string;
    scope: "app" | "user";
    consent: PluginConsent;
    settlementSessionId?: string;
  }) {
    const [detail] = await this.options.service.installed({ plugins: [input.plugin] }, owner);
    const current = detail?.readiness[input.requirement]?.consent;
    if (
      current?.digest !== input.consent.digest ||
      detail?.plugin.requirements.accounts[input.requirement]?.scope !== input.scope
    )
      throw new OpensteerError({
        code: "conflict",
        message: "Plugin consent changed; review the account link again.",
      });
    if (
      !detail.links.some(
        (link) =>
          link.requirement === input.requirement && link.scope === input.scope && link.current,
      )
    )
      return;
    const pending = await this.options.store.database
      .selectFrom("requests")
      .select("id")
      .where("kind", "=", "plugin.account")
      .where("status", "=", "pending")
      .where("requestedBy", "=", input.owner)
      .execute();
    for (const row of pending) {
      const request = await this.options.store.requests.get(row.id);
      const p = request?.payload;
      if (
        p?.kind !== "plugin.account" ||
        p.plugin !== input.plugin ||
        p.requirement !== input.requirement ||
        p.scope !== input.scope ||
        p.consent.digest !== input.consent.digest
      )
        continue;
      await this.options.store.requests.settlePluginRequest({
        requestId: row.id,
        resolvedBy: input.owner,
        decision: "fulfilled",
        ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
      });
    }
    this.options.changed?.(input.owner);
  }
  handlers(): Partial<AgentToolHandlers> {
    const o = this.options;
    const handlers: Partial<AgentToolHandlers> = {
      opensteer_plugin_catalog: async (c) => {
        const page = await o.service.catalogList(
          { ...c.input, limit: c.input.limit ?? 20 },
          o.authority.admit(c.caller),
          c.signal,
        );
        // The engine lists an unread feed as empty, which is not "no such plugin".
        if (page.feed.status !== "listed") throw new ToolBlockedError(catalogUnavailable);
        return {
          items: page.items.map((entry) => ({
            id: entry.id,
            name: entry.name.slice(0, 120),
            description: entry.description.split("\n")[0]!.slice(0, 300),
            accounts: entry.auth
              .slice(0, 8)
              .map((method) =>
                String(method.label ?? method.method ?? method.kind ?? "Account").slice(0, 80),
              ),
          })),
          cursor: page.cursor,
        };
      },
      plugin_skills: (c) => o.service.skills(c.input, o.authority.admit(c.caller), c.signal),
      plugin_resources: (c) =>
        o.service.resourcesRead(
          { ...c.input, outputs: c.caller.kind !== "connection" },
          o.authority.admit(c.caller),
          c.signal,
        ),
      opensteer_plugin_resource_update: async (c) => {
        const change = c.input.change;
        if (
          callerLineage(c.caller) &&
          (change.action === "workflow.start" ||
            change.action === "schedule.run" ||
            (change.action === "schedule.configure" && change.enabled))
        )
          throw new OpensteerError({
            code: "forbidden",
            message: "Ask the person to start the workflow or schedule themselves.",
          });
        await c.checkLive?.();
        const result = await o.service.resourcesUpdate(
          {
            ...c.input,
            key: JSON.stringify([c.caller.userId, pluginCaller(c.caller).caller, c.operationKey]),
          },
          o.authority.admit(c.caller),
          c.signal,
        );
        const categories = {
          "schedule.configure": ["schedules"],
          "schedule.run": ["schedules", "scheduledRuns"],
          "workflow.start": ["workflowRuns"],
          "workflow.stop": ["workflowRuns"],
          "webhook.remove": ["webhooks"],
        } satisfies Record<typeof c.input.change.action, PluginResourceCategory[]>;
        o.changed?.(c.caller.userId, {
          pluginId: c.input.pluginId,
          categories: categories[c.input.change.action],
        });
        return result;
      },
      plugin_search: async (c) => {
        const context = o.authority.admit(c.caller);
        return this.discoveryResult(context, await o.service.search(c.input, context, c.signal));
      },
      plugin_describe: async (c) => {
        const context = o.authority.admit(c.caller);
        return this.discoveryResult(context, await o.service.describe(c.input, context, c.signal));
      },
      plugin_call: (c) =>
        c.caller.kind === "connection"
          ? this.#directExecution(c.caller, c)
          : o.executions.execute(c.caller, "call", c.input, c.signal),
      plugin_execute: (c) =>
        c.caller.kind === "connection"
          ? this.#directExecution(c.caller, c)
          : o.executions.execute(c.caller, "execute", c.input, c.signal),
      plugin_resume: (c) =>
        c.caller.kind === "connection"
          ? this.#directExecution(c.caller, c)
          : o.executions.resume(c.caller, c.input.executionId, c.signal),
      opensteer_plugin_list: (c) => this.list(c),
      opensteer_plugin_install: (c) => this.install(c),
      opensteer_plugin_export: (c) => this.export(c),
      opensteer_plugin_activate: async (c) => {
        await o.service.activate(
          { plugin: c.input.pluginId, version: c.input.versionId },
          o.authority.admit(c.caller),
          c.signal,
        );
        o.changed?.(c.caller.userId);
        return { ok: true };
      },
      opensteer_plugin_remove: async (c) => {
        await o.service.remove({ plugin: c.input.pluginId }, o.authority.admit(c.caller), c.signal);
        await o.executions.cancelPlugin(c.caller.userId, c.input.pluginId);
        o.removed?.(c.input.pluginId);
        o.changed?.(c.caller.userId);
        return { ok: true };
      },
      plugin_account_request: (c) => this.#accountRequest(c),
    };
    const scope = <K extends keyof AgentToolHandlers>(name: K) => {
      const handler = handlers[name] as ((c: ToolCall<K>) => Promise<unknown>) | undefined;
      if (handler)
        handlers[name] = ((c: ToolCall<K>) =>
          o.authority.scoped(c.caller, () => handler(c))) as AgentToolHandlers[K];
    };
    for (const name of Object.keys(handlers) as (keyof AgentToolHandlers)[]) scope(name);
    return handlers;
  }
}

/** A saved install result as the engine answers it, with the plugin's namespaced slug. */
function installedView(result: z.infer<typeof operations.install.output>) {
  return result.status === "installed"
    ? { ...result, plugin: { ...result.plugin, slug: pluginNamespace(result.plugin.slug) } }
    : result;
}
