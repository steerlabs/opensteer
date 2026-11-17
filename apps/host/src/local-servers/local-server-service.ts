import { readdir, realpath } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AesGcmSecretVault } from "@opensteer/access/host";
import { createCredentialResponseRedactor } from "@opensteer/access/host";
import type { LocalServerPackageServer } from "@opensteer/agent-plugins";
import {
  OpensteerError,
  UserIdSchema,
  refused,
  type RunId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type {
  CallableIntegrationTool,
  DiscoveredIntegrationServer,
  InstallIntegrationInput,
  IntegrationPlatformStore,
} from "@opensteer/database";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import { createIntegrationId, type IntegrationServerId } from "@opensteer/integration-core/ids";
import { localMcpLaunchSecrets, type LocalMcpLaunch } from "@opensteer/integration-core/local-mcp";
import {
  IntegrationServerTransportSchema,
  type IntegrationServer,
} from "@opensteer/integration-core/models";
import { isNodeError } from "@opensteer/shared/nodeError";
import { assertPluginDataId, removePluginData } from "@opensteer/shared/privateFiles";
import { safeMessage } from "@opensteer/shared/safeMessage";
import type { ToolCaller } from "../agents/tool-caller.js";
import { ComputerMcpSessionError, type ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { computerAppTransportUnavailableDetail } from "../computer-apps/computer-app-availability.js";
import { ComputerMcpTransport } from "./computer-mcp-transport.js";
import { LocalMcpSecrets } from "./local-mcp-secrets.js";
import {
  McpClientPool,
  answeredMcpError,
  connectMcpClient,
  emptyToolCatalog,
  listTools,
  safeMessageOptions,
  sanitizeToolResult,
  type UpstreamClient,
} from "./mcp-clients.js";
import { ServerInput, serverInputTimeoutMs } from "./server-input.js";

/** A server a plugin declares, as the Host stores it before anything has started it. */
export interface PendingLocalServer extends DiscoveredIntegrationServer {
  readonly authorizationRequired: boolean;
}

type LocalServerRow = Awaited<ReturnType<IntegrationPlatformStore["localMcp"]["list"]>>[number];

/**
 * The MCP servers computers run for their owners: a program a computer
 * starts, or a server on its own loopback. The Host is their MCP client
 * through the computer's `integrations` stream; each runs only as its
 * computer's owner approved it, with the secrets they entered.
 */
export class LocalServerService {
  /**
   * The servers a computer runs whose tools are being listed, one listing per
   * server at a time, each listed once more when asked again meanwhile.
   */
  readonly #discoveries = new Map<IntegrationServerId, { again: boolean }>();
  readonly #computerApps: Pick<
    ComputerAppHub,
    | "attached"
    | "openMcpSession"
    | "removePluginData"
    | "requireAgentAccess"
    | "withRunnerAdmission"
  >;
  readonly #dataDirectory: string;
  readonly #isRunnerConnected: (runnerId: RunnerId) => boolean;
  readonly #onConnectionsChanged: () => void;
  readonly #onSettingsChanged: (input: {
    installationId?: string;
    ownerUserId?: UserId;
  }) => Promise<void>;
  readonly #personal: boolean;
  readonly #store: IntegrationPlatformStore;
  /** The MCP clients the Host holds for the servers computers run. */
  readonly clients: McpClientPool;
  readonly inputRequests: ServerInput;
  /** Seals what computer owners enter for their MCP servers' secrets. */
  readonly secrets: LocalMcpSecrets;

  constructor(options: {
    readonly computerApps: Pick<
      ComputerAppHub,
      | "attached"
      | "openMcpSession"
      | "removePluginData"
      | "requireAgentAccess"
      | "withRunnerAdmission"
    >;
    readonly dataDirectory: string;
    readonly isRunnerConnected: (runnerId: RunnerId) => boolean;
    readonly onConnectionsChanged: () => void;
    readonly onSettingsChanged?: (input: {
      installationId?: string;
      ownerUserId?: UserId;
    }) => Promise<void>;
    readonly personal?: boolean;
    readonly secretVault: Pick<AesGcmSecretVault, "open" | "seal">;
    readonly store: IntegrationPlatformStore;
  }) {
    this.#computerApps = options.computerApps;
    this.#dataDirectory = options.dataDirectory;
    this.#isRunnerConnected = options.isRunnerConnected;
    this.#onConnectionsChanged = options.onConnectionsChanged;
    this.#onSettingsChanged = options.onSettingsChanged ?? (async () => undefined);
    this.#personal = options.personal ?? false;
    this.#store = options.store;
    this.secrets = new LocalMcpSecrets(options.secretVault);
    this.inputRequests = new ServerInput();
    this.clients = new McpClientPool({
      onClientClosed: (client) => this.inputRequests.forget(client),
    });
  }

  /**
   * The owner of the computer that runs an approved server gave some of its
   * secrets new values. Its sessions end, so the next one starts with them,
   * and it lists its tools again.
   */
  async setServerSecrets(input: {
    readonly actorUserId: UserId;
    readonly secrets: Readonly<Record<string, string>>;
    readonly serverId: IntegrationServerId;
  }): Promise<void> {
    const server = await this.#store.localMcp.get(input.serverId);
    if (!server)
      throw new OpensteerError({ code: "not_found", message: "That server isn't installed." });
    await this.#store.localMcp.setSecrets({
      actorUserId: input.actorUserId,
      launchDigest: server.launchDigest,
      secrets: this.secrets.update(server.id, server.launch, input.secrets),
      serverId: server.id,
    });
    this.clients.dropServer(server.id);
    void this.discoverServer(server.id).catch((error: unknown) =>
      console.warn("An MCP server could not be started with its new secrets", error),
    );
  }

  /**
   * Asks each computer about the servers pinned to it that it has not
   * approved as they now launch, and sends each one its approvals again.
   */
  async requestLocalServerApprovals(): Promise<void> {
    const changed = await this.#store.localMcp.requestApprovals();
    if (changed.length > 0) this.#onConnectionsChanged();
  }

  async deliverPluginDataRemovals(runnerId?: RunnerId): Promise<void> {
    for (const pending of await this.#store.plugins.pendingDataRemovals(runnerId))
      await this.#computerApps.removePluginData(pending.runnerId, pending.pluginId);
  }

  async recoverPluginData(): Promise<void> {
    const directory = `${await realpath(this.#dataDirectory)}/plugins/data`;
    const plugins = await this.#store.plugins.list();
    const retained = new Set(plugins.map((plugin) => plugin.id));
    // Package snapshots and pre-migration name-based data are not orphan plugin state.
    retained.add("packages");
    for (const installation of await this.#store.listInstallations())
      if (installation.id === installation.pluginId) retained.add(installation.name);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const id of entries) {
      if (retained.has(id)) continue;
      try {
        assertPluginDataId(id);
      } catch {
        continue;
      }
      await removePluginData(directory, id);
    }
  }

  async removePluginData(pluginId: string): Promise<void> {
    await removePluginData(`${await realpath(this.#dataDirectory)}/plugins/data`, pluginId);
    await this.deliverPluginDataRemovals();
  }

  /**
   * A computer's stream attached. Servers it approved and has not started
   * yet — approved while it was offline, or whose start failed — start now.
   */
  computerRunnerAttached(runnerId: RunnerId): void {
    void this.deliverPluginDataRemovals(runnerId).catch((error: unknown) =>
      console.warn("Plugin data removal could not be delivered", error),
    );
    this.startApprovedServers((server) => server.runnerId === runnerId);
  }

  /** Lists every approved server `which` names that is not listed yet. */
  startApprovedServers(which: (server: LocalServerRow) => boolean): void {
    void (async () => {
      for (const server of await this.#store.localMcp.list()) {
        if (
          which(server) &&
          server.status === "needs-attention" &&
          server.approvedLaunchDigest === server.launchDigest
        ) {
          await this.discoverServer(server.id);
        }
      }
    })().catch((error: unknown) =>
      console.warn("MCP servers could not start on a computer", error),
    );
  }

  /**
   * Starts a server its computer approved, once, to learn its tools. A
   * computer that is offline starts it when it is back. Asked again while it
   * runs, it lists once more after, from what is on record then.
   */
  async discoverServer(serverId: IntegrationServerId): Promise<void> {
    if (this.clients.closed) return;
    const running = this.#discoveries.get(serverId);
    if (running) {
      running.again = true;
      return;
    }
    const discovery = { again: true };
    this.#discoveries.set(serverId, discovery);
    try {
      while (discovery.again && !this.clients.closed) {
        discovery.again = false;
        await this.#discoverOnce(serverId);
      }
    } finally {
      this.#discoveries.delete(serverId);
    }
    this.#onConnectionsChanged();
    const server = await this.#store.localMcp.get(serverId);
    if (server) await this.#onSettingsChanged({ installationId: server.installationId });
  }

  async #discoverOnce(serverId: IntegrationServerId): Promise<void> {
    const server = await this.#store.localMcp.get(serverId);
    if (this.clients.closed) return;
    if (
      !server?.runnerId ||
      server.status === "disabled" ||
      server.approvedLaunchDigest !== server.launchDigest
    ) {
      return;
    }
    const { launchDigest, runnerId } = server;
    // Held with the calls' clients, so whatever lets the server go ends its
    // listing too.
    const key = `${serverId}:listing`;
    const listing = this.clients.open(key, server.installationId, async (signal) => ({
      client: await this.#connect(
        { id: serverId, transport: { launch: server.launch, runnerId, type: "runner" } },
        signal,
      ),
      computer: null,
      fingerprint: launchDigest,
    }));
    const { signal } = listing.cancel;
    try {
      const tools = await listTools((await listing.client).client);
      if (signal.aborted) return;
      await this.#store.localMcp.recordTools({ launchDigest, serverId, tools });
    } catch (error) {
      if (signal.aborted) return;

      await this.#store.localMcp.recordFailure({
        detail:
          error instanceof ComputerMcpSessionError && error.code === "offline"
            ? `${server.runnerName ?? "Its computer"} is offline; the server starts when it is back.`
            : safeMessage(error, safeMessageOptions),
        launchDigest,
        serverId,
      });
    } finally {
      this.clients.letGo(key, listing);
    }
  }

  /**
   * A tool of an MCP server one computer runs. What went wrong is said the
   * way a computer app says it — which computer, and whether a change may
   * already have happened — because a lost answer to a write is not a
   * failure a caller may simply retry.
   */
  async callTool(
    callable: CallableIntegrationTool,
    args: Readonly<Record<string, unknown>>,
    caller: ToolCaller,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const server = await this.#store.localMcp.get(callable.server.id);
    let responseRedactor = createCredentialResponseRedactor([]);
    const refusal = (text: string) =>
      sanitizeToolResult(
        { content: [{ text, type: "text" as const }], isError: true },
        responseRedactor,
      );
    let upstream: UpstreamClient;
    try {
      upstream = await this.#client(callable);
    } catch (error) {
      return refusal(await this.#refusal(callable, server, error));
    }
    let release: () => void;
    try {
      release = await this.inputRequests.turn(upstream.client, signal);
    } catch {
      return refusal("The call was cancelled before it started.");
    }
    const call = this.inputRequests.start(
      upstream.client,
      callable,
      caller,
      signal,
      server?.runnerName ?? "its computer",
    );
    let admissionError: Error | undefined;
    const authorize = async () => {
      try {
        call.signal.throwIfAborted();
        const current = (
          await this.#store.listCallableTools({
            ownerUserId: UserIdSchema.parse(callable.grant.ownerUserId),
            threadId: caller.threadId,
          })
        ).find(
          (candidate) =>
            candidate.grant.id === callable.grant.id &&
            candidate.tool.id === callable.tool.id &&
            candidate.tool.schemaDigest === callable.tool.schemaDigest &&
            JSON.stringify(candidate.server.transport) ===
              JSON.stringify(callable.server.transport),
        );
        if (!current)
          throw refused(
            "forbidden",
            "Local tool authority changed while the call was queued; the call was not sent.",
          );
        call.signal.throwIfAborted();
        await caller.authorize?.();
        call.signal.throwIfAborted();
      } catch (error) {
        admissionError =
          error instanceof Error
            ? error
            : new Error("Local tool authority changed; the call was not sent.");
        throw admissionError;
      }
    };
    if (upstream.computer) upstream.computer.beforeToolCall = authorize;
    try {
      if (!upstream.computer) await authorize();
      const result = await upstream.client.callTool(
        { arguments: { ...args }, name: callable.tool.name },
        undefined,
        {
          maxTotalTimeout: serverInputTimeoutMs,
          signal: call.signal,
          timeout: serverInputTimeoutMs,
        },
      );
      return sanitizeToolResult(result, call.redactor());
    } catch (error) {
      responseRedactor = call.redactor();
      if (admissionError)
        return refusal(
          "Local tool authority changed or the call was cancelled while queued; the call was not sent. Do not retry until access is restored.",
        );
      if (answeredMcpError(error)) {
        // The server answered, with an error: nothing about it is uncertain.
        return refusal(
          responseRedactor
            .redactText(
              `${callable.installation.title} could not complete ${callable.tool.title}: ${error.message}`,
            )
            .slice(0, 2_000),
        );
      }
      if (call.timedOut || !call.signal.aborted) upstream.letGo();
      const computer = server?.runnerName ?? "Its computer";
      const closed = upstream.computer?.closeError ?? null;
      if (integrationToolEffect(callable.tool.annotations) === "write") {
        return refusal(
          `${computer} did not confirm this${
            closed?.code === "too-large" ? ": its answer was too large to carry" : ""
          }. Check whether it happened before trying again.`,
        );
      }
      return refusal(
        closed?.code === "too-large"
          ? `${callable.installation.title}'s answer was too large to carry from ${computer}; ask for less.`
          : `${computer} did not answer. Try again.`,
      );
    } finally {
      if (upstream.computer?.beforeToolCall === authorize)
        upstream.computer.beforeToolCall = undefined;
      await this.inputRequests.finish(upstream.client, call);
      release();
    }
  }

  /** Why a computer did not start a server's session, as a caller reads it. */
  async #refusal(
    callable: CallableIntegrationTool,
    server: Awaited<ReturnType<IntegrationPlatformStore["localMcp"]["get"]>>,
    error: unknown,
  ): Promise<string> {
    const title = callable.installation.title;
    if (!server || server.status === "disabled") {
      return `${title} was removed or changed; find its tools again.`;
    }
    if (!server.runnerId || !server.runnerName) {
      return `${title} has no computer to run on. Register it again with local_server_add, choosing one.`;
    }
    if (!(error instanceof ComputerMcpSessionError)) {
      return `${title} did not start on ${server.runnerName}: ${safeMessage(error, safeMessageOptions)}`;
    }
    switch (error.code) {
      case "offline":
        return computerAppTransportUnavailableDetail(
          title,
          server.runnerName,
          this.#isRunnerConnected(server.runnerId),
        );
      case "unapproved":
      case "failed":
      case "too-large":
        return `${title} did not start on ${server.runnerName}: ${error.message}`;
    }
  }

  /**
   * What an inventory says about a server a computer runs: nothing while that
   * computer is there, otherwise why its tools are unavailable.
   */
  async availability(
    runnerId: RunnerId,
    title: string,
    computerName: () => Promise<string>,
  ): Promise<string | null> {
    // A server a computer runs is there exactly while that computer is.
    if (this.#computerApps.attached(runnerId)) return null;
    return computerAppTransportUnavailableDetail(
      title,
      await computerName(),
      this.#isRunnerConnected(runnerId),
    );
  }

  #client(callable: CallableIntegrationTool): Promise<UpstreamClient> {
    return this.clients.client(callable, (signal) => this.#connect(callable.server, signal));
  }

  /**
   * Refuses to open a server on a computer unless it is still installed there,
   * launched exactly so, and approved so.
   */
  async #assertServerCurrent(
    serverId: IntegrationServerId,
    transport: { readonly launch: LocalMcpLaunch; readonly runnerId: RunnerId },
  ): Promise<void> {
    const current = await this.#store.localMcp.get(serverId);
    if (
      !current ||
      current.status === "disabled" ||
      current.runnerId !== transport.runnerId ||
      current.launchDigest !== localMcpLaunchDigest(transport.launch) ||
      current.approvedLaunchDigest !== current.launchDigest
    ) {
      throw refused("conflict", "It was removed or changed as this started; find its tools again.");
    }
  }

  /**
   * An MCP client for a server one computer runs: the session is carried to
   * that computer, which starts the program or reaches its own loopback.
   */
  async #connect(
    server: Pick<IntegrationServer, "id" | "transport">,
    signal?: AbortSignal,
  ): Promise<Client> {
    const { transport } = server;
    const client = new Client(
      { name: "opensteer-integration-host", version: "1.0.0" },
      transport.type === "runner" ? { capabilities: { elicitation: { form: {} } } } : {},
    );
    if (transport.type !== "runner") {
      throw new Error("Only a server a computer runs opens through that computer");
    }
    this.inputRequests.register(client);
    if (!transport.runnerId) {
      throw refused(
        "conflict",
        "No computer runs this MCP server; register it again with local_server_add, choosing one.",
      );
    }
    // Every open is held in the pool before it gets here, so a removal or
    // change either finds it and ends it or is read here first: nothing
    // starts on the computer for a server as it no longer is.
    await this.#assertServerCurrent(server.id, {
      launch: transport.launch,
      runnerId: transport.runnerId,
    });
    // Read after that check: changing them ends every session this opens.
    const secrets = await this.secrets.values(
      server.id,
      transport.launch,
      await this.#store.localMcp.secrets(server.id, transport.runnerId),
    );
    signal?.throwIfAborted();
    const computer = new ComputerMcpTransport(this.#computerApps, {
      authorize: () =>
        this.#assertServerCurrent(server.id, {
          launch: transport.launch,
          runnerId: transport.runnerId!,
        }),
      launch: transport.launch,
      runnerId: transport.runnerId,
      secrets,
      serverId: server.id,
    });
    return connectMcpClient(client, computer, signal, (error) => {
      this.inputRequests.forget(client);
      // The computer's own reason says more than the SDK's "Connection closed".
      return computer.closeError ?? error;
    });
  }

  /**
   * The computer an install asks for. An agent's update stays on the plugin's
   * computer while it is enrolled, not the computer of the Run that updated it;
   * a person's names one or keeps it.
   */
  async updateComputer(
    input: { readonly runnerId?: RunnerId | undefined; readonly threadId?: unknown },
    previousServers: readonly { readonly runnerId: RunnerId | null; readonly status: string }[],
  ): Promise<RunnerId | undefined> {
    // A removed server keeps the computer it last ran on; a current one says where the plugin is.
    const previous =
      (
        previousServers.find((s) => s.runnerId && s.status !== "disabled") ??
        previousServers.find((s) => s.runnerId)
      )?.runnerId ?? null;
    const kept =
      previous !== null && (await this.#store.localMcp.computerName(previous)) !== null
        ? previous
        : undefined;
    return input.threadId ? (kept ?? input.runnerId) : (input.runnerId ?? kept);
  }

  /** The computer a plugin's own servers run on: the one named, or the Main one. */
  async pluginComputer(runnerId: RunnerId | undefined): Promise<RunnerId> {
    const chosen = runnerId ?? (await this.#store.localMcp.mainComputer());
    if (!chosen) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "This plugin runs its servers on a computer. Choose the computer that runs them: this Deployment has no Main computer.",
      });
    }
    if ((await this.#store.localMcp.computerName(chosen)) === null) {
      throw new OpensteerError({
        code: "not_found",
        message: "That computer is not part of this Deployment.",
      });
    }
    await this.#store.requireSelfDeviceId(chosen);
    if ((await this.#store.computerAppRunner(chosen))?.deviceProfile === "iphone")
      throw new OpensteerError({
        code: "forbidden",
        message: "Local servers can't run on an iPhone.",
      });
    return chosen;
  }

  /**
   * What an update keeps of a server a computer runs: on a Personal
   * Deployment, its approval when nothing its owner would review changed, and
   * the secrets the new launch still declares.
   */
  retainedServer(
    ...[existing, discovered]: Parameters<NonNullable<InstallIntegrationInput["retainedServer"]>>
  ): ReturnType<NonNullable<InstallIntegrationInput["retainedServer"]>> {
    return existing.transport.type === "runner" && discovered.transport.type === "runner"
      ? {
          carryApproval:
            this.#personal && carriesApproval(existing, existing.transport, discovered.transport),
          secrets: this.secrets.prune(existing.id, discovered.transport.launch),
        }
      : null;
  }

  endRun(runId: RunId, generation?: number): void {
    this.inputRequests.endRun(runId, generation);
  }

  async close(): Promise<void> {
    await this.inputRequests.close();
    await this.clients.close();
  }
}

function computerLaunch(server: LocalServerPackageServer): LocalMcpLaunch {
  return server.type === "stdio"
    ? {
        args: [...server.args],
        command: server.command,
        cwd: server.cwd,
        env: { ...server.env },
        ...(server.secrets ? { secrets: server.secrets.map((secret) => ({ ...secret })) } : {}),
        type: "stdio",
      }
    : { headers: { ...server.headers }, type: "streamable-http", url: server.url };
}

function portableComputerLaunch(server: LocalServerPackageServer): LocalMcpLaunch {
  const launch = computerLaunch(server);
  if (launch.type !== "stdio") return launch;
  const root = launch.env.PLUGIN_ROOT!;
  const data = launch.env.PLUGIN_DATA!;
  const portable = (value: string) =>
    value.replaceAll(root, "${PLUGIN_ROOT}").replaceAll(data, "${PLUGIN_DATA}");
  return {
    ...launch,
    command: portable(launch.command),
    cwd: portable(launch.cwd),
    args: launch.args.map(portable),
    env: Object.fromEntries(Object.entries(launch.env).map(([k, v]) => [k, portable(v)])),
  };
}

/**
 * Whether a Personal Deployment's update keeps a server's approval: on the same
 * computer, approved as it launched, not declined, and asking for no secret it
 * didn't, whose value its owner would have to enter.
 */
export function carriesApproval(
  existing: { readonly approvedLaunchDigest: string | null; readonly status: string },
  previous: { readonly launch: LocalMcpLaunch; readonly runnerId: RunnerId | null },
  next: { readonly launch: LocalMcpLaunch; readonly runnerId: RunnerId | null },
): boolean {
  const declared = new Set(localMcpLaunchSecrets(previous.launch).map(({ name }) => name));
  return (
    previous.runnerId === next.runnerId &&
    existing.status !== "disabled" &&
    existing.approvedLaunchDigest === localMcpLaunchDigest(previous.launch) &&
    localMcpLaunchSecrets(next.launch).every(({ name }) => declared.has(name))
  );
}

/** A plugin server pinned to its computer, waiting for that computer's approval. */
export function pendingLocalServer(
  server: LocalServerPackageServer,
  runnerId: RunnerId,
  packageDigest: string,
  pluginId: string,
): PendingLocalServer {
  return {
    authorizationRequired: false,
    catalog: emptyToolCatalog,
    connectionRequirement: { kind: "none" },
    id: createIntegrationId("server"),
    name: server.name,
    status: "needs-attention",
    statusDetail: "Waiting for approval on the computer that runs it.",
    transport: IntegrationServerTransportSchema.parse({
      launch: { ...portableComputerLaunch(server), packageDigest, pluginId },
      runnerId,
      type: "runner",
    }),
  };
}
