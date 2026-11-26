import { lentNow, lentRequester } from "../mcp/lent-now.js";
import {
  deviceAppBlocked,
  deviceAppUnavailable,
  deviceAccessBlocked,
  localTargetBlocked,
} from "../devices/target-blocked.js";
import type { Blocked } from "@opensteer/core";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import { isLocalProviderId, localNamespace, slugify } from "./provider-names.js";
import { createHash } from "node:crypto";
import { localToolBlocked, type LocalToolResponse } from "../local-servers/mcp-clients.js";
import type { DeviceId, UserId } from "@opensteer/core";
import type { IntegrationPlatformStore, IntegrationRequester } from "@opensteer/database";
import { deviceDefinitions } from "@opensteer/integration-catalog/devices";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import {
  IntegrationConnectionIdSchema,
  IntegrationServerIdSchema,
} from "@opensteer/integration-core";
import { computerUseDefinitionId } from "../computer-use/computer-use-service.js";
import { dataAppName } from "../devices/access-requests.js";
import type { DeviceService } from "../devices/device-service.js";
import {
  localServerStatus,
  type LocalServerService,
} from "../local-servers/local-server-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { ToolCaller } from "../agents/tool-caller.js";
import { normalizeToolError } from "@opensteer/agent-tools";
import { agentToolFailure, internalToolFailureCode } from "../mcp/agent-tool-failure.js";
import {
  directMcpResultBytes,
  jsonBytes,
  LocalMcpResultSchema,
  type HostToolResult,
  PluginServiceError,
  type PluginCaller,
  type PluginHostProvider,
  type PluginJson,
} from "./engine-protocol.js";
import type { PluginAuthority } from "./plugin-authority.js";
import type { PluginElicit } from "./plugin-service.js";

/**
 * Device data apps and local MCP servers as providers in the plugin tool namespace. Every listing
 * and call is read live from the device stack for the caller behind the engine's caller string;
 * nothing is cached, and a call goes only to the computer its provider names. A provider's tools
 * are always listed, from Opensteer's definitions or the list its last approved launch saved:
 * what keeps an agent from them now is one blocked marker, and an unreachable device is said by
 * the call.
 */
type Located = PluginHostProvider & {
  readonly kind: "device-app" | "local-server";
  readonly computer: { readonly id: DeviceId; readonly name: string } | null;
  readonly phoneAddedAt?: Date;
  readonly ownerUnavailable?: string;
  readonly installationId: string;
  readonly installationName: string;
  readonly serverId: string;
  readonly connectionId: string | null;
  readonly transport: "computer" | "runner";
  /** What app_access_request names this provider by: a data app's name or a server's. */
  readonly requestName: string;
  /** The app's own title, without its device. */
  readonly title: string;
  readonly waitingForLaunchApproval?: true;
  readonly blocked?: Blocked;
  readonly toolBlockers: Readonly<Record<string, Blocked>>;
};
interface LocalProvidersOptions {
  readonly store: IntegrationPlatformStore;
  readonly devices: Pick<
    DeviceService,
    "withAvailability" | "callTool" | "localDeviceAccessBlocked" | "localDiscoveryFacts"
  >;
  readonly localServers: Pick<LocalServerService, "callTool">;
  readonly authority: Pick<PluginAuthority, "caller" | "authorize"> &
    Partial<Pick<PluginAuthority, "session">>;
}
export class LocalProviders {
  readonly #options: LocalProvidersOptions;
  constructor(options: LocalProvidersOptions) {
    this.#options = options;
  }
  async providers(context: PluginCaller): Promise<PluginHostProvider[]> {
    const caller = this.#options.authority.caller(context.caller);
    if (!caller) return [];
    return (
      await this.#list(
        caller,
        undefined,
        this.#options.authority.session?.(context.caller)?.operation.bindingId,
      )
    ).providers.map(
      ({
        kind: _k,
        computer: _m,
        phoneAddedAt: _added,
        ownerUnavailable: _detail,
        installationId: _i,
        installationName: _n,
        serverId: _s,
        connectionId: _c,
        transport: _t,
        requestName: _r,
        title: _title,
        waitingForLaunchApproval: _approval,
        toolBlockers,
        ...provider
      }) => (Object.keys(toolBlockers).length ? { ...provider, toolBlockers } : provider),
    );
  }

  /** The person-facing name of a provider this caller can see, for its Requests. */
  async name(context: PluginCaller, plugin: string): Promise<string | undefined> {
    if (!isLocalProviderId(plugin)) return undefined;
    const caller = this.#options.authority.caller(context.caller);
    if (!caller) return "Local tool";
    return (
      (
        await this.#list(
          caller,
          plugin,
          this.#options.authority.session?.(context.caller)?.operation.bindingId,
        )
      ).providers[0]?.name ?? "Local tool"
    );
  }

  async call(
    input: PluginCaller & { execution: string; plugin: string; tool: string; input: PluginJson },
    signal: AbortSignal,
    elicit: PluginElicit,
  ): Promise<HostToolResult> {
    const caller = this.#options.authority.caller(input.caller);
    const session = this.#options.authority.session?.(input.caller);
    if (!caller || (caller.kind === "connection" && !session))
      throw failure("Local tools are called only from a task or its programs.");
    const { providers, callables } = await this.#list(
      caller,
      input.plugin,
      session?.operation.bindingId,
    );
    const [provider] = providers;
    if (!provider) throw failure("This local tool was removed or changed; search again.");
    if (provider.blocked) {
      const access =
        provider.kind === "device-app" && provider.computer
          ? await this.#options.devices.localDeviceAccessBlocked(
              provider.computer.id,
              caller.kind === "connection",
            )
          : undefined;
      return {
        kind: "blocked",
        blocked: access ?? provider.toolBlockers[input.tool] ?? provider.blocked,
      };
    }
    const tool = provider.tools.find(({ name }) => name === input.tool);
    const callable = callables.find(
      (candidate) =>
        candidate.installation.id === provider.installationId &&
        candidate.server.id === provider.serverId &&
        (candidate.grant.connectionId ?? null) === provider.connectionId &&
        candidate.tool.name === input.tool,
    );
    const blocked = provider.toolBlockers[input.tool];
    if (blocked) return { kind: "blocked", blocked };
    if (!tool || !callable)
      throw failure(
        `${provider.name} has no tool ${input.tool} now; use ${caller.kind === "connection" ? "discover" : "plugin_search"} for current tools.`,
      );
    if (!input.input || typeof input.input !== "object" || Array.isArray(input.input))
      throw failure(`${input.tool} takes an object of arguments.`);
    const assertAuthority = async (transaction?: Parameters<PluginAuthority["authorize"]>[2]) => {
      const permission = await this.#options.authority.authorize(
        { ...input, operation: "call", write: !tool.readOnly, version: provider.version },
        signal,
        transaction,
      );
      if (
        !permission.allowed ||
        permission.grants?.[input.plugin] === "off" ||
        (permission.grants?.[input.plugin] === "read-only" && !tool.readOnly)
      ) {
        throw failure("Local tool authority changed while waiting; the call was not sent.");
      }
    };
    const toolCaller: ToolCaller = {
      run: caller.kind === "run" ? caller.claims : null,
      threadId:
        caller.kind === "run"
          ? caller.thread.id
          : caller.kind === "program"
            ? caller.anchor.id
            : session!.operation.taskId,
      agentBindingId: session?.operation.bindingId ?? caller.key,
      elicit,
      authorize: async () => {
        signal.throwIfAborted();
        const liveCaller = this.#options.authority.caller(input.caller);
        if (!liveCaller)
          throw failure("Local tool caller is no longer active; the call was not sent.");
        const live = await this.#list(liveCaller, input.plugin, session?.operation.bindingId);
        const [current] = live.providers;
        if (
          !current ||
          current.blocked ||
          current.version !== provider.version ||
          !live.callables.some(
            (entry) =>
              entry.grant.id === callable.grant.id &&
              entry.tool.id === callable.tool.id &&
              entry.tool.schemaDigest === callable.tool.schemaDigest,
          )
        )
          throw failure(
            "Local tool authority or identity changed while waiting; the call was not sent.",
          );
        await assertAuthority();
      },
      authorizeAtHandoff: assertAuthority,
    };
    let result: LocalToolResponse;
    try {
      result =
        provider.transport === "computer"
          ? await this.#options.devices.callTool(callable, input.input, toolCaller, signal)
          : await this.#options.localServers.callTool(callable, input.input, toolCaller, signal);
    } catch (error) {
      if (error instanceof PluginServiceError && error.code === "tool") throw error;
      const access = deviceAccessBlocked(error, caller.kind === "connection");
      if (access) return { kind: "blocked", blocked: access };
      const refusal = agentToolFailure(error, tool.readOnly ? "read" : "write");
      if (refusal.code === internalToolFailureCode) throw error;
      const { code, message, next } = normalizeToolError(refusal);
      return {
        kind: "blocked",
        blocked: {
          code,
          message,
          next: next ?? "Continue without this tool and tell the person what the message says.",
        },
      };
    }
    if (result[localToolBlocked]) return { kind: "blocked", blocked: result[localToolBlocked] };
    if (Array.isArray(result.content) && result.content.some((part) => part.type !== "text")) {
      const mcp = LocalMcpResultSchema.parse(result);
      if (jsonBytes(mcp) > directMcpResultBytes)
        throw failure(`${provider.name}'s answer was too large to carry; ask for less.`);
      return { kind: "mcp", result: mcp };
    }
    const text = (Array.isArray(result.content) ? result.content : [])
      .flatMap((part: { type?: unknown; text?: unknown }) =>
        part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n");
    if (result.isError)
      return {
        kind: "blocked",
        blocked: {
          code: "unavailable",
          message: text.slice(0, 2_000) || `${provider.name} could not complete ${input.tool}.`,
          next: "Continue without this tool and tell the person what the message says.",
        },
      };
    if (result.structuredContent)
      return { kind: "value", value: JSON.parse(JSON.stringify(result.structuredContent)) };
    try {
      return { kind: "value", value: JSON.parse(text) as PluginJson };
    } catch {
      return { kind: "value", value: text };
    }
  }

  /**
   * Every local provider of the personal owner as Settings shows it: what agents type, where it
   * runs, why it is unavailable, and its tools. No task's ceiling applies.
   */
  async owned(owner: UserId, id?: string) {
    const { providers } = await this.#list({ kind: "owner", userId: owner }, id);
    const phonesByName = new Map<string, Map<DeviceId, Date>>();
    for (const { computer, phoneAddedAt } of providers) {
      if (!computer || !phoneAddedAt) continue;
      const phones = phonesByName.get(computer.name) ?? new Map<DeviceId, Date>();
      phones.set(computer.id, phoneAddedAt);
      phonesByName.set(computer.name, phones);
    }
    const setupNumbers = new Map<DeviceId, number>();
    for (const phones of phonesByName.values()) {
      if (phones.size < 2) continue;
      [...phones]
        .sort(([aId, a], [bId, b]) => a.getTime() - b.getTime() || aId.localeCompare(bId))
        .forEach(([deviceId], index) => setupNumbers.set(deviceId, index + 1));
    }
    return providers.map((entry) => {
      const setup = entry.computer && setupNumbers.get(entry.computer.id);
      const suffix = setup ? ` · Setup ${setup}` : "";
      return {
        id: entry.id,
        kind: entry.kind,
        name: entry.slug,
        title: `${entry.name.slice(0, 240 - suffix.length)}${suffix}`,
        computer: entry.computer,
        unavailable: (entry.ownerUnavailable ?? entry.blocked?.message)?.slice(0, 1000) ?? null,
        ...(entry.waitingForLaunchApproval ? { waitingForLaunchApproval: true as const } : {}),
        tools: entry.blocked
          ? []
          : entry.tools.map(({ name, readOnly }) => ({ name, readOnly: readOnly === true })),
      };
    });
  }

  #withToolBlockers(
    provider: Located,
    inventory: Awaited<ReturnType<IntegrationPlatformStore["listDiscoveryInventory"]>>,
    callables: Awaited<ReturnType<IntegrationPlatformStore["listCallableTools"]>>,
    readOnlyConnections: ReadonlyMap<string, boolean>,
    canAsk: boolean,
    lookup: "discover" | "plugin_search",
    connection: boolean,
  ): Located {
    // Every operation that cannot run carries its own reason, whether or not anything else of its
    // app can: a call is about that one operation (a read is never refused for a write's reason).
    const entry = inventory.find((entry) => entry.installation.id === provider.installationId);
    const stateFor = (tool: string) => {
      const row = entry?.tools.find(
        (row) =>
          row.serverId === provider.serverId &&
          (row.connectionId ?? null) === provider.connectionId &&
          row.name === tool,
      );
      return entry?.readiness.tools.find((state) => state.toolId === row?.id)?.readiness;
    };
    const needed = provider.tools.filter((tool) => {
      const state = stateFor(tool.name);
      return (
        (state && state.code !== "READY") ||
        !callables.some(
          (row) =>
            row.installation.id === provider.installationId &&
            row.server.id === provider.serverId &&
            (row.grant.connectionId ?? null) === provider.connectionId &&
            row.tool.name === tool.name,
        )
      );
    });
    if (!needed.length) return provider;
    const blockers = needed.map((tool) => {
      let state = stateFor(tool.name);
      if (!state || state.code === "READY")
        state = entry?.readiness.forTarget?.(IntegrationServerIdSchema.parse(provider.serverId), {
          connectionId: provider.connectionId
            ? IntegrationConnectionIdSchema.parse(provider.connectionId)
            : null,
          access: tool.readOnly ? "read" : "read-write",
        });
      const blocked =
        provider.kind === "device-app" && provider.computer
          ? deviceAppBlocked(state, {
              name: provider.name,
              app: provider.title,
              device: provider.computer.name,
              dataApp: provider.requestName,
              computerId: provider.computer.id,
              readOnlyGrant:
                !tool.readOnly &&
                !!provider.connectionId &&
                readOnlyConnections.get(provider.connectionId) === true,
              operation: tool.name,
              canAsk,
              connection,
            })
          : localTargetBlocked(
              state,
              provider.name,
              { server: provider.requestName },
              canAsk,
              connection,
            );
      return [
        tool.name,
        blocked ??
          // An operation with no state of its own is kept by what keeps its app.
          provider.blocked ?? {
            code: "unavailable",
            message: `${provider.name} has no usable ${tool.name} operation.`,
            next: `Use ${lookup} for current tools; continue other work.`,
          },
      ] as const;
    });
    return { ...provider, toolBlockers: Object.fromEntries(blockers) };
  }

  async #list(
    caller: AgentCaller | { readonly kind: "owner"; readonly userId: UserId },
    id?: string,
    bindingId?: string,
  ) {
    const requested = id === undefined ? undefined : providerTarget(id);
    if (id !== undefined && !requested) return { providers: [], callables: [] };
    const metadataOnly = caller.kind === "owner";
    const store = this.#options.store;
    const canAsk =
      caller.kind === "run" || (caller.kind === "program" && caller.program.kind === "trigger");
    // A connected agent has no task to ask for access from: it is told only what the person does.
    const connected = caller.kind === "connection";
    // What the one rule lends this caller's connection lineage now, read once for the call.
    const lent =
      caller.kind === "owner"
        ? null
        : await lentNow(caller, (owner, grant) => store.grantedDeviceApprovals(owner, grant));
    const requester: IntegrationRequester =
      caller.kind === "owner"
        ? { ownerUserId: caller.userId, kind: "person" }
        : caller.kind === "connection" && !bindingId
          ? {
              ownerUserId: caller.userId,
              connectionId: caller.connectionId,
              ...lentRequester(lent),
            }
          : // The exact execution, so its own lineage and mode decide, never another Run's.
            {
              ownerUserId: caller.userId,
              agentBindingId: bindingId ?? caller.key,
              ...lentRequester(lent),
            };
    const facts = this.#options.devices.localDiscoveryFacts(requester.ownerUserId);
    const [inventory, callables] = await Promise.all([
      store
        .listDiscoveryInventory({
          ...requester,
          ...(!metadataOnly ? { includeTargetReadiness: true } : {}),
          ...(requested ? { provider: requested } : {}),
        })
        .then((entries) =>
          this.#options.devices.withAvailability(
            entries,
            // A device that is only unreachable is left to the call, which says it is offline;
            // a connected agent is told so in its listing too (reachable false, the device's words).
            { ...requester, ownerView: metadataOnly, offlineAtCall: !metadataOnly && !connected },
            facts,
          ),
        ),
      metadataOnly ? [] : store.listCallableTools(requester),
    ]);
    const localServers = inventory.some((entry) =>
      entry.servers.some(({ transport }) => transport.type === "runner"),
    )
      ? await facts.localServers()
      : [];
    const readOnlyConnections = new Map<string, boolean>();
    const located: Located[] = [];
    for (const entry of inventory) {
      for (const server of entry.servers) {
        const readiness = entry.readiness.servers.filter(({ serverId }) => serverId === server.id);
        if (server.transport.type === "computer") {
          const definition = deviceDefinitions.find(
            ({ id }) => id === (server.transport as { definitionId: string }).definitionId,
          );
          if (
            !definition ||
            !isComputerAppDefinition(definition) ||
            definition.id === computerUseDefinitionId ||
            isPhoneDisplayDefinitionId(definition.id)
          )
            continue;
          // Server readiness names one connection; each connection's own state is on its tool rows.
          for (const account of entry.accounts) {
            const providerId = `app_device_${account.connectionId}`;
            if (id !== undefined && providerId !== id) continue;
            const states = entry.tools.flatMap((tool) =>
              tool.serverId === server.id && tool.connectionId === account.connectionId
                ? entry.readiness.tools
                    .filter(({ toolId }) => toolId === tool.id)
                    .map(({ readiness }) => readiness)
                : [],
            );
            const ready = states.some(({ code }) => code === "READY");
            // When nothing can run, the app's one line (what discover and a listing say of the
            // whole app) is its most basic reason; a call is about one operation and says that
            // operation's own (`#withToolBlockers`).
            const state = appReason(states);
            if (!ready && !state) continue;
            const connection = await facts.connectionFor(account.connectionId);
            if (!connection) continue;
            readOnlyConnections.set(account.connectionId, connection.access === "read");
            located.push(
              provider({
                id: providerId,
                kind: "device-app",
                base: dataAppName(definition),
                computer: { id: connection.deviceId, name: connection.runnerName },
                phoneAddedAt:
                  connection.deviceProfile === "iphone" ? connection.deviceAddedAt : undefined,
                name: `${entry.installation.title} on ${connection.runnerName}`,
                installationId: entry.installation.id,
                installationName: entry.installation.name,
                serverId: server.id,
                connectionId: account.connectionId,
                transport: "computer",
                requestName: dataAppName(definition),
                title: entry.installation.title,
                blocked: ready
                  ? undefined
                  : state?.code === "INTEGRATION_UNAVAILABLE" && state.detail
                    ? // What the device reports, as discover and the device's state read it.
                      deviceAppUnavailable({
                        detail: state.detail,
                        app: entry.installation.title,
                        device: connection.runnerName,
                      })
                    : localTargetBlocked(
                        state,
                        `${entry.installation.title} on ${connection.runnerName}`,
                        {
                          dataApp: dataAppName(definition),
                          computerId: connection.deviceId,
                        },
                        canAsk,
                        connected,
                      ),
                unavailable: ready
                  ? undefined
                  : (state?.detail ??
                    (state?.code === "ACCESS_GRANT_REQUIRED"
                      ? "Agents need access. Request it from a task."
                      : `${entry.installation.title} is unavailable on ${connection.runnerName}.`)),
                tools: definition.config.operations.map((operation) => ({
                  name: operation.name,
                  description: `${operation.title}. ${skillReference(operation.description)}`.slice(
                    0,
                    2000,
                  ),
                  inputSchema: metadataOnly
                    ? {}
                    : JSON.parse(JSON.stringify(operation.inputSchema)),
                  readOnly: operation.effect === "read",
                })),
              }),
            );
          }
        } else if (server.transport.type === "runner") {
          const providerId = `app_server_${server.id}`;
          if (id !== undefined && providerId !== id) continue;
          const state = readiness[0];
          const tools = entry.tools.filter((tool) => tool.serverId === server.id);
          const listed = await Promise.all(
            tools.map(async (tool) => {
              const schemas = metadataOnly ? null : await store.getToolSchemas(tool.id);
              return {
                name: tool.name,
                description: (tool.description || tool.title).slice(0, 2000),
                inputSchema: JSON.parse(
                  JSON.stringify(schemas?.inputSchema ?? { type: "object" }),
                ) as Record<string, PluginJson>,
                readOnly: integrationToolEffect(tool.annotations) === "read",
              };
            }),
          );
          const runnerId = server.transport.runnerId;
          const localServer = localServers.find(({ id }) => id === server.id);
          // The registered plugin's name, the one name access requests and removal look up.
          const serverName = localServer?.pluginName ?? entry.installation.title;
          const launchStatus = localServer ? localServerStatus(localServer) : undefined;
          located.push(
            provider({
              id: providerId,
              kind: "local-server",
              base: serverName,
              computer:
                localServer?.deviceId && localServer.runnerName
                  ? { id: localServer.deviceId, name: localServer.runnerName }
                  : null,
              named: false,
              name: entry.installation.title,
              installationId: entry.installation.id,
              installationName: entry.installation.name,
              serverId: server.id,
              connectionId: null,
              transport: "runner",
              requestName: serverName,
              title: entry.installation.title,
              ...(launchStatus?.state === "waiting"
                ? { waitingForLaunchApproval: true as const }
                : {}),
              blocked:
                launchStatus?.blocked ??
                localTargetBlocked(
                  state,
                  entry.installation.title,
                  {
                    server: serverName,
                  },
                  canAsk,
                  connected,
                ) ??
                (!runnerId
                  ? {
                      code: "setup_required",
                      message: `${entry.installation.title} has no computer to run on.`,
                      next: "Call local_server_add again, choosing its computer.",
                    }
                  : undefined),
              unavailable:
                !state || state.code === "READY"
                  ? runnerId
                    ? undefined
                    : `${entry.installation.title} has no computer to run on. Register it again, choosing one.`
                  : (launchStatus?.detail ??
                    state.detail ??
                    (state.code === "ACCESS_GRANT_REQUIRED"
                      ? "Agents need access. Request it from a task."
                      : `${entry.installation.title} is unavailable on its computer.`)),
              tools: listed,
            }),
          );
        }
      }
    }
    const assessed = metadataOnly
      ? located
      : located.map((provider) =>
          this.#withToolBlockers(
            provider,
            inventory,
            callables,
            readOnlyConnections,
            canAsk,
            caller.kind === "connection" ? "discover" : "plugin_search",
            connected,
          ),
        );
    // A data app its device cannot serve now (its Apps switch off, offline, asleep, stopped) reads
    // as a call to it says it, for a connected agent and a Run alike, each in its own words: the
    // device's own refusal first, for the app and each operation. One read per device.
    const refusals = new Map<string, Promise<Blocked | undefined>>();
    const deviceRefusal = (deviceId: DeviceId) => {
      let refusal = refusals.get(deviceId);
      if (!refusal) {
        refusal = this.#options.devices
          .localDeviceAccessBlocked(deviceId, connected)
          // A device the Home no longer knows is left to what the inventory says of it.
          .catch(() => undefined);
        refusals.set(deviceId, refusal);
      }
      return refusal;
    };
    const shown = metadataOnly
      ? assessed
      : await Promise.all(
          assessed.map(async (entry) => {
            if (entry.kind !== "device-app" || !entry.computer) return entry;
            const device = await deviceRefusal(entry.computer.id);
            return device
              ? {
                  ...entry,
                  blocked: device,
                  toolBlockers: Object.fromEntries(entry.tools.map(({ name }) => [name, device])),
                }
              : entry;
          }),
        );
    const providers = shown
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ ...entry, slug: localNamespace(entry.slug, entry.id) }))
      .map((entry) => ({
        ...entry,
        version: metadataOnly
          ? entry.version
          : `dpl_${createHash("sha256")
              .update(JSON.stringify([entry.slug, entry.tools]))
              .digest("hex")
              .slice(0, 32)}`,
      }));
    return { providers, callables };
  }
}

/**
 * The order an app's one line takes its reason in, when none of its operations can run: what the
 * device reports first, then the person's setup, then the grant, and the task's mode last. A task's
 * read-only mode or a missing grant is never said in front of what keeps the device itself.
 */
const appReasonOrder = [
  "INTEGRATION_UNAVAILABLE",
  "USER_AUTHORIZATION_REQUIRED",
  "REAUTHORIZATION_REQUIRED",
  "ACCESS_GRANT_REQUIRED",
  "READ_ONLY_TASK",
] as const;
function appReason<State extends { readonly code: string }>(
  states: readonly State[],
): State | undefined {
  for (const code of appReasonOrder) {
    const found = states.find((state) => state.code === code);
    if (found) return found;
  }
  return undefined;
}

function providerTarget(id: string) {
  if (id.startsWith("app_device_")) {
    const connectionId = IntegrationConnectionIdSchema.safeParse(id.slice("app_device_".length));
    if (connectionId.success) return { connectionId: connectionId.data };
  } else if (id.startsWith("app_server_")) {
    const serverId = IntegrationServerIdSchema.safeParse(id.slice("app_server_".length));
    if (serverId.success) return { serverId: serverId.data };
  }
  return undefined;
}

function provider(input: {
  id: string;
  kind: Located["kind"];
  base: string;
  computer: Located["computer"];
  phoneAddedAt?: Date | undefined;
  /** Whether the address carries the computer's name, as a device app's does. */
  named?: boolean;
  name: string;
  installationId: string;
  installationName: string;
  serverId: string;
  connectionId: string | null;
  transport: "computer" | "runner";
  requestName: string;
  title: string;
  unavailable: string | undefined;
  waitingForLaunchApproval?: true;
  blocked?: Blocked | undefined;
  tools: PluginHostProvider["tools"];
}): Located {
  return {
    id: input.id,
    name: input.name.slice(0, 240),
    slug: slugify(
      input.computer === null || input.named === false
        ? input.base
        : `${input.base}-${input.computer.name}`,
    ),
    kind: input.kind,
    computer: input.computer,
    version: "dpl_pending",
    tools: input.tools,
    toolBlockers: {},
    installationId: input.installationId,
    installationName: input.installationName,
    serverId: input.serverId,
    connectionId: input.connectionId,
    transport: input.transport,
    requestName: input.requestName,
    title: input.title,
    ...(input.phoneAddedAt ? { phoneAddedAt: input.phoneAddedAt } : {}),
    ...(input.unavailable ? { ownerUnavailable: input.unavailable } : {}),
    ...(input.waitingForLaunchApproval ? { waitingForLaunchApproval: true as const } : {}),
    ...(input.blocked
      ? { blocked: input.blocked }
      : input.unavailable
        ? {
            blocked: {
              code: "unavailable",
              message: input.unavailable.slice(0, 2000),
              next: "Continue without it and tell the person what the message says.",
            },
          }
        : {}),
  };
}

// Native contracts pin this text in their digests; change only its agent-facing skill reference.
function skillReference(description: string): string {
  return description.replace(
    "reference in opensteer:integrations",
    "reference in opensteer:plugins",
  );
}

function failure(message: string) {
  return new PluginServiceError("tool", message.slice(0, 4000));
}
