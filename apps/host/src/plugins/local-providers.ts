import { localTargetBlocked } from "../devices/target-blocked.js";
import type { Blocked } from "@opensteer/core";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import { localToolPath, localNamespace, slugify } from "./provider-names.js";
import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { UserId } from "@opensteer/core";
import type { IntegrationPlatformStore, IntegrationRequester } from "@opensteer/database";
import { deviceDefinitions } from "@opensteer/integration-catalog/devices";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import type { IntegrationInstallation } from "@opensteer/integration-core";
import { IntegrationConnectionIdSchema } from "@opensteer/integration-core";
import { computerUseDefinitionId } from "../computer-use/computer-use-service.js";
import { dataAppName } from "../devices/access-requests.js";
import type { DeviceService } from "../devices/device-service.js";
import type { LocalServerService } from "../local-servers/local-server-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { ToolCaller } from "../agents/tool-caller.js";
import { normalizeToolError } from "@opensteer/agent-tools";
import { agentToolFailure, internalToolFailureCode } from "../mcp/agent-tool-failure.js";
import {
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
 * nothing is cached, and a call goes only to the computer its provider names.
 */
type Located = PluginHostProvider & {
  readonly kind: "device-app" | "local-server";
  readonly computer: { readonly id: string; readonly name: string } | null;
  readonly installationId: string;
  readonly installationName: string;
  readonly serverId: string;
  readonly connectionId: string | null;
  readonly transport: "computer" | "runner";
  /** What app_access_request names this provider by: a data app's name or a server's. */
  readonly requestName: string;
  readonly blocked?: Blocked;
  readonly toolBlockers: Readonly<Record<string, Blocked>>;
};
/** How an agent asks for more of a provider: the data app on its computer, or the server by name. */
const requestAccess = (provider: Pick<Located, "kind" | "computer" | "requestName">) =>
  provider.kind === "device-app"
    ? `call app_access_request with dataApp "${provider.requestName}"${provider.computer ? `, computerId "${provider.computer.id}"` : ""} and access "read-write"; do not retry this call until it is fulfilled`
    : `call app_access_request with server "${provider.requestName}" and access "read-write"; do not retry this call until it is fulfilled`;

interface LocalProvidersOptions {
  readonly store: IntegrationPlatformStore;
  readonly devices: Pick<DeviceService, "withAvailability" | "callTool">;
  readonly localServers: Pick<LocalServerService, "callTool">;
  readonly authority: Pick<PluginAuthority, "caller" | "authorize">;
}
export class LocalProviders {
  readonly #options: LocalProvidersOptions;
  constructor(options: LocalProvidersOptions) {
    this.#options = options;
  }
  async providers(context: PluginCaller): Promise<PluginHostProvider[]> {
    const caller = this.#options.authority.caller(context.caller);
    if (!caller) return [];
    return (await this.#list(caller)).providers.map(
      ({
        kind: _k,
        computer: _m,
        installationId: _i,
        installationName: _n,
        serverId: _s,
        connectionId: _c,
        transport: _t,
        requestName: _r,
        blocked: _b,
        toolBlockers: _tb,
        ...provider
      }) => provider,
    );
  }

  async blockers(context: PluginCaller) {
    const caller = this.#options.authority.caller(context.caller);
    const result: { id: string; slug: string; path?: string; blocked: Blocked }[] = [];
    if (!caller) return result;
    for (const provider of (await this.#list(caller)).providers) {
      if (provider.blocked)
        result.push({ id: provider.id, slug: provider.slug, blocked: provider.blocked });
      for (const [tool, blocked] of Object.entries(provider.toolBlockers))
        result.push({
          id: provider.id,
          slug: provider.slug,
          path: localToolPath(provider.slug, tool),
          blocked,
        });
    }
    return result;
  }

  /** The person-facing name of a provider this caller can see, for its Requests. */
  async name(context: PluginCaller, plugin: string): Promise<string | undefined> {
    if (!plugin.startsWith("app_device_") && !plugin.startsWith("app_server_")) return undefined;
    return (await this.providers(context)).find(({ id }) => id === plugin)?.name ?? "Local tool";
  }

  async call(
    input: PluginCaller & { execution: string; plugin: string; tool: string; input: PluginJson },
    signal: AbortSignal,
    elicit: PluginElicit,
  ): Promise<PluginJson> {
    const caller = this.#options.authority.caller(input.caller);
    if (!caller || caller.kind === "connection")
      throw failure("Local tools are called only from a task or its programs.");
    const { providers, callables } = await this.#list(caller);
    const provider = providers.find(({ id }) => id === input.plugin);
    if (!provider) throw failure("This local tool was removed or changed; search again.");
    if (provider.unavailable) throw failure(provider.unavailable);
    const tool = provider.tools.find(({ name }) => name === input.tool);
    const callable = callables.find(
      (candidate) =>
        candidate.installation.id === provider.installationId &&
        candidate.server.id === provider.serverId &&
        (candidate.grant.connectionId ?? null) === provider.connectionId &&
        candidate.tool.name === input.tool,
    );
    const blocked = provider.toolBlockers[input.tool];
    if (blocked) throw failure(`${blocked.message} ${blocked.next}`);
    if (!tool || !callable)
      throw failure(
        `${provider.name} has no tool ${input.tool} now; use plugin_search for current tools.`,
      );
    if (!input.input || typeof input.input !== "object" || Array.isArray(input.input))
      throw failure(`${input.tool} takes an object of arguments.`);
    const toolCaller: ToolCaller = {
      run: caller.kind === "run" ? caller.claims : null,
      threadId: caller.kind === "run" ? caller.thread.id : caller.anchor.id,
      elicit,
      authorize: async () => {
        signal.throwIfAborted();
        const liveCaller = this.#options.authority.caller(input.caller);
        if (!liveCaller)
          throw failure("Local tool caller is no longer active; the call was not sent.");
        const live = await this.#list(liveCaller);
        const current = live.providers.find((entry) => entry.id === input.plugin);
        if (
          !current ||
          current.unavailable ||
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
        const permission = await this.#options.authority.authorize(
          { ...input, operation: "call", write: !tool.readOnly },
          signal,
        );
        if (
          !permission.allowed ||
          permission.grants?.[input.plugin] === "off" ||
          (permission.grants?.[input.plugin] === "read-only" && !tool.readOnly)
        ) {
          throw failure("Local tool authority changed while waiting; the call was not sent.");
        }
      },
    };
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result =
        provider.transport === "computer"
          ? await this.#options.devices.callTool(callable, input.input, toolCaller, signal)
          : await this.#options.localServers.callTool(callable, input.input, toolCaller, signal);
    } catch (error) {
      // The same projection agent tools use, so a refusal keeps its computer and next step.
      const refusal = agentToolFailure(error, tool.readOnly ? "read" : "write");
      if (refusal.code === internalToolFailureCode) throw error;
      const { message, next } = normalizeToolError(refusal);
      const live = await this.#list(caller).catch(() => undefined);
      const currentProvider = live?.providers.find((entry) => entry.id === provider.id);
      const current = currentProvider?.toolBlockers[input.tool] ?? currentProvider?.blocked;
      throw failure([...new Set([message, next, current?.next].filter(Boolean))].join(" "));
    }
    const text = (Array.isArray(result.content) ? result.content : [])
      .flatMap((part: { type?: unknown; text?: unknown }) =>
        part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n");
    if (result.isError) throw failure(text || `${provider.name} could not complete ${input.tool}.`);
    if (result.structuredContent) return JSON.parse(JSON.stringify(result.structuredContent));
    try {
      return JSON.parse(text) as PluginJson;
    } catch {
      return text;
    }
  }

  /**
   * Every local provider of the personal owner as Settings shows it: what agents type, where it
   * runs, why it is unavailable, and its tools. No task's ceiling applies.
   */
  async owned(owner: UserId) {
    return (await this.#list({ kind: "owner", userId: owner })).providers.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.slug,
      title: entry.name,
      computer: entry.computer,
      unavailable: entry.unavailable?.slice(0, 1000) ?? null,
      tools: entry.tools.map(({ name, readOnly }) => ({ name, readOnly: readOnly === true })),
    }));
  }

  async #withToolBlockers(
    provider: Located,
    inventory: Awaited<ReturnType<IntegrationPlatformStore["listDiscoveryInventory"]>>,
    callables: Awaited<ReturnType<IntegrationPlatformStore["listCallableTools"]>>,
    requester: IntegrationRequester,
    readOnlyConnections: ReadonlyMap<string, boolean>,
    canAsk: boolean,
  ): Promise<Located> {
    if (provider.unavailable) return provider;
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
    const scopes = new Map<
      "read" | "read-write",
      Promise<Awaited<ReturnType<IntegrationPlatformStore["listDiscoveryInventory"]>>>
    >();
    const scoped = (access: "read" | "read-write") => {
      let result = scopes.get(access);
      if (!result) {
        result = this.#options.store
          .listDiscoveryInventory({
            ...requester,
            target: {
              connectionId: provider.connectionId
                ? IntegrationConnectionIdSchema.parse(provider.connectionId)
                : null,
              access,
            },
          })
          .then((entries) => this.#options.devices.withAvailability(entries, requester));
        scopes.set(access, result);
      }
      return result;
    };
    const blockers = await Promise.all(
      needed.map(async (tool) => {
        let state = stateFor(tool.name);
        if (!state || state.code === "READY")
          state = (await scoped(tool.readOnly === true ? "read" : "read-write"))
            .find((entry) => entry.installation.id === provider.installationId)
            ?.readiness.servers.find((state) => state.serverId === provider.serverId);
        let blocked = localTargetBlocked(state, provider.name, requestTarget(provider), canAsk) ?? {
          code: "unavailable",
          message: `${provider.name} has no usable ${tool.name} operation.`,
          next: "Use plugin_search for current tools; continue other work.",
        };
        if (
          blocked.code === "access_required" &&
          !tool.readOnly &&
          provider.connectionId &&
          readOnlyConnections.get(provider.connectionId)
        )
          blocked = {
            ...blocked,
            message: `${provider.name} allows reading only.`,
            next: canAsk ? `To ${tool.name}, ${requestAccess(provider)}.` : blocked.next,
          };
        return [tool.name, blocked] as const;
      }),
    );
    const toolBlockers = Object.fromEntries(blockers);
    return {
      ...provider,
      toolBlockers,
      tools: provider.tools.map((tool) => {
        const blocked = toolBlockers[tool.name];
        return blocked
          ? {
              ...tool,
              description:
                `Blocked (${blocked.code}); call tools.search.describe for this tool before using it.\n${blocked.message} ${blocked.next}\n${tool.description}`.slice(
                  0,
                  2000,
                ),
            }
          : tool;
      }),
    };
  }

  async #list(caller: AgentCaller | { readonly kind: "owner"; readonly userId: UserId }) {
    const store = this.#options.store;
    const canAsk =
      caller.kind === "run" || (caller.kind === "program" && caller.program.kind === "trigger");
    const requester: IntegrationRequester =
      caller.kind === "owner"
        ? { ownerUserId: caller.userId }
        : caller.kind === "connection"
          ? { ownerUserId: caller.userId, connectionId: caller.connectionId }
          : {
              ownerUserId: caller.userId,
              threadId: caller.kind === "run" ? caller.thread.id : caller.anchor.id,
            };
    const [inventory, callables] = await Promise.all([
      store
        .listDiscoveryInventory(requester)
        .then((entries) => this.#options.devices.withAvailability(entries, requester)),
      store.listCallableTools(requester),
    ]);
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
            const states = entry.tools.flatMap((tool) =>
              tool.serverId === server.id && tool.connectionId === account.connectionId
                ? entry.readiness.tools
                    .filter(({ toolId }) => toolId === tool.id)
                    .map(({ readiness }) => readiness)
                : [],
            );
            const ready = states.some(({ code }) => code === "READY");
            const state = states.find(({ code }) => code !== "READY");
            if (!ready && !state) continue;
            const connection = await store.getDeviceComputerConnectionForCall({
              connectionId: account.connectionId,
              ownerUserId: caller.userId as UserId,
            });
            if (!connection) continue;
            readOnlyConnections.set(account.connectionId, connection.access === "read");
            located.push(
              provider({
                id: `app_device_${account.connectionId}`,
                kind: "device-app",
                base: dataAppName(definition),
                computer: { id: connection.deviceId, name: connection.runnerName },
                name: `${entry.installation.title} on ${connection.runnerName}`,
                installationId: entry.installation.id,
                installationName: entry.installation.name,
                serverId: server.id,
                connectionId: account.connectionId,
                transport: "computer",
                requestName: dataAppName(definition),
                blocked: ready
                  ? undefined
                  : localTargetBlocked(
                      state,
                      `${entry.installation.title} on ${connection.runnerName}`,
                      { dataApp: dataAppName(definition), computerId: connection.deviceId },
                      canAsk,
                    ),
                unavailable: ready
                  ? undefined
                  : (state?.detail ??
                    `${entry.installation.title} is unavailable on ${connection.runnerName}.`),
                tools: definition.config.operations.map((operation) => ({
                  name: operation.name,
                  description: `${operation.title}. ${skillReference(operation.description)}`.slice(
                    0,
                    2000,
                  ),
                  inputSchema: JSON.parse(JSON.stringify(operation.inputSchema)),
                  readOnly: operation.effect === "read",
                })),
              }),
            );
          }
        } else if (server.transport.type === "runner") {
          const state = readiness[0];
          const tools = entry.tools.filter((tool) => tool.serverId === server.id);
          const listed = await Promise.all(
            tools.map(async (tool) => {
              const schemas = await store.getToolSchemas(tool.id);
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
          located.push(
            provider({
              id: `app_server_${server.id}`,
              kind: "local-server",
              base: serverName(entry.installation),
              computer: runnerId
                ? { id: runnerId, name: (await store.localMcp.computerName(runnerId)) ?? runnerId }
                : null,
              named: false,
              name: entry.installation.title,
              installationId: entry.installation.id,
              installationName: entry.installation.name,
              serverId: server.id,
              connectionId: null,
              transport: "runner",
              requestName: serverName(entry.installation),
              blocked:
                localTargetBlocked(
                  state,
                  entry.installation.title,
                  {
                    server: serverName(entry.installation),
                  },
                  canAsk,
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
                  : (state.detail ??
                    `${entry.installation.title} is waiting for the person to approve it on its computer. Do not retry until they do.`),
              tools: listed,
            }),
          );
        }
      }
    }
    const assessed = await Promise.all(
      located.map((provider) =>
        this.#withToolBlockers(
          provider,
          inventory,
          callables,
          requester,
          readOnlyConnections,
          canAsk,
        ),
      ),
    );
    const providers = assessed
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ ...entry, slug: localNamespace(entry.slug, entry.id) }))
      .map((entry) => ({
        ...entry,
        tools: entry.unavailable ? [] : entry.tools,
        version: `dpl_${createHash("sha256")
          .update(JSON.stringify([entry.slug, entry.unavailable ?? null, entry.tools]))
          .digest("hex")
          .slice(0, 32)}`,
      }));
    return { providers, callables };
  }
}

function provider(input: {
  id: string;
  kind: Located["kind"];
  base: string;
  computer: Located["computer"];
  /** Whether the address carries the computer's name, as a device app's does. */
  named?: boolean;
  name: string;
  installationId: string;
  installationName: string;
  serverId: string;
  connectionId: string | null;
  transport: "computer" | "runner";
  requestName: string;
  unavailable: string | undefined;
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
    ...(input.blocked
      ? {
          blocked: input.blocked,
          unavailable: `${input.blocked.message} ${input.blocked.next}`.slice(0, 2000),
        }
      : input.unavailable
        ? {
            blocked: {
              code: "unavailable",
              message: input.unavailable.slice(0, 2000),
              next: "Continue without it and tell the person what the message says.",
            },
            unavailable:
              `${input.unavailable} Continue without it and tell the person what the message says.`.slice(
                0,
                2000,
              ),
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

/** A registered server's own name, which registration keeps unique per person. */
function serverName(installation: IntegrationInstallation): string {
  const name = installation.manifest.name;
  return typeof name === "string" ? name : installation.title;
}

function failure(message: string) {
  return new PluginServiceError("tool", message.slice(0, 4000));
}

function requestTarget(provider: Pick<Located, "kind" | "computer" | "requestName">) {
  return provider.kind === "device-app" && provider.computer
    ? { dataApp: provider.requestName, computerId: provider.computer.id }
    : { server: provider.requestName };
}
