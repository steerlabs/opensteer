import { localNamespace, slugify } from "../plugins/provider-names.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshotLocalServerPackage } from "@opensteer/agent-plugins";
import {
  OpensteerError,
  refused,
  type AgentEvent,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { AdministrationCommandIdentity, IntegrationPlatformStore } from "@opensteer/database";
import {
  createIntegrationId,
  pluginDeviceFromManifest,
  type IntegrationInstallation,
  type IntegrationInstallationId,
} from "@opensteer/integration-core";
import type { DeviceService } from "../devices/device-service.js";
import type { AgentHomeFiles } from "../threads/agent-home-files.js";
import { withFolderPluginPackage } from "./folder-plugin-package.js";
import { pendingLocalServer, type LocalServerService } from "./local-server-service.js";

export interface LocalServerRegistration {
  readonly name: string;
  readonly description?: string | undefined;
  readonly computerId?: RunnerId | undefined;
  readonly launch?:
    | {
        readonly command: string;
        readonly args?: readonly string[] | undefined;
        readonly env?: Readonly<Record<string, string>> | undefined;
        readonly cwd?: string | undefined;
        readonly secrets?:
          readonly { name: string; title: string; description?: string | undefined }[] | undefined;
      }
    | undefined;
  readonly url?: string | undefined;
  readonly folder?: string | undefined;
  readonly device?: { readonly name: string; readonly kind: string } | undefined;
}

/**
 * Local servers registered directly by a name, a computer and a launch or loopback URL. A
 * registration is stored as the plugin record local servers already use (one server, an optional
 * package snapshot by digest), so the owner's launch approval, secret entry and data removal are
 * the existing ones.
 */
export class LocalServerRegistry {
  readonly #options: {
    readonly store: IntegrationPlatformStore;
    readonly dataDirectory: string;
    readonly devices: Pick<DeviceService, "endSessionsForRemovedApps" | "withRunnerAdmissions">;
    readonly localServers: Pick<
      LocalServerService,
      | "clients"
      | "pluginComputer"
      | "removePluginData"
      | "requestLocalServerApprovals"
      | "retainedServer"
      | "startApprovedServers"
      | "updateComputer"
    >;
    readonly files: () => Promise<Pick<AgentHomeFiles, "list" | "download">>;
    readonly onConnectionsChanged: () => void;
    readonly onDeploymentEvent: (event: AgentEvent) => void;
    readonly onRequestsChanged: () => void;
    readonly onProviderRemoved?: (owner: UserId, provider: string) => Promise<void>;
    readonly onSettingsChanged: (input: { installationId?: string }) => Promise<void>;
  };
  constructor(options: LocalServerRegistry["options"]) {
    this.#options = options;
  }
  get options() {
    return this.#options;
  }

  async add(
    actor: { readonly userId: UserId; readonly threadId: ThreadId },
    input: LocalServerRegistration,
    requestId: string,
    authorize?: () => Promise<void>,
  ) {
    const install = (directory: string) =>
      this.installPackage({
        actorUserId: actor.userId,
        authorize,
        directory,
        registration: input,
        threadId: actor.threadId,
        requestId,
        runnerId: input.computerId,
      });
    let result: Awaited<ReturnType<typeof install>>;
    if (input.folder)
      result = await withFolderPluginPackage({
        directory: input.folder,
        files: await this.#options.files(),
        install,
      });
    else {
      const directory = await mkdtemp(join(tmpdir(), "opensteer-local-server-"));
      try {
        result = await install(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    const issues = result.issues.map((issue) =>
      typeof issue === "object" && issue !== null && "message" in issue
        ? String(issue.message)
        : String(issue),
    );
    const server = (await this.list(actor.userId)).find(({ name }) => name === input.name);
    if (!server)
      throw new OpensteerError({
        code: "bad_request",
        message: `${input.name} was not registered: ${issues.join(" ") || "its launch is invalid"}`,
        next: "Correct the launch or URL and call local_server_add again.",
      });
    return {
      server,
      issues,
      next:
        server.state === "approved"
          ? `Use plugin_search for ${server.path}.`
          : "The person reviews it on that computer in Needs you. Its tools appear in plugin_search once approved; do not register it again meanwhile.",
    };
  }

  async list(owner: UserId) {
    const store = this.#options.store;
    const [plugins, servers, installations] = await Promise.all([
      store.plugins.list(),
      store.localMcp.list(),
      store.listInstallations(),
    ]);
    return plugins
      .filter((plugin) => plugin.installedBy === owner)
      .flatMap((plugin) => {
        const installation = installations.find(({ pluginId }) => pluginId === plugin.id);
        const device = pluginDeviceFromManifest(installation?.manifest);
        return servers
          .filter(({ installationId }) => installationId === installation?.id)
          .map((server) => ({
            name: plugin.name,
            pluginId: plugin.id,
            path: toolsPath(localNamespace(slugify(plugin.name), `app_server_${server.id}`)),
            computer: server.runnerName,
            computerId: server.runnerId,
            kind: server.launch.type === "stdio" ? ("program" as const) : ("loopback" as const),
            state:
              server.status === "disabled" || server.runnerId === null
                ? ("unavailable" as const)
                : server.approvedLaunchDigest === server.launchDigest
                  ? ("approved" as const)
                  : ("waiting" as const),
            ...(device ? { device } : {}),
          }));
      });
  }

  async remove(
    actor: { readonly userId: UserId },
    name: string,
    requestId: string,
    authorize?: () => Promise<void>,
  ) {
    const plugin = (await this.#options.store.plugins.list()).find(
      (candidate) => candidate.name === name && candidate.installedBy === actor.userId,
    );
    if (!plugin)
      throw new OpensteerError({
        code: "not_found",
        message: `No local server is named ${name}.`,
        next: "Use local_server_list for the registered names.",
      });
    await this.removePlugin(actor, plugin.id, requestId, undefined, authorize);
  }

  /** Removes a registered server's plugin record with its installation, grants and data. */
  async removePlugin(
    actor: { readonly userId: UserId },
    pluginId: string,
    requestId: string,
    administration?: AdministrationCommandIdentity,
    authorize?: () => Promise<void>,
  ) {
    const store = this.#options.store;
    await store.plugins.assertCanRemove(pluginId, actor);
    const installations = (await store.listInstallations()).filter(
      (installation) => installation.pluginId === pluginId,
    );
    if (installations.length === 0) await authorize?.();
    for (const installation of installations)
      await this.uninstall({
        installationId: installation.id,
        actorUserId: actor.userId,
        requestId,
        authorize,
      });
    await store.plugins.remove(pluginId, administration);
    await this.#options.localServers.removePluginData(pluginId);
  }

  /**
   * Installs, or updates by name for the same person, the registered package: its
   * servers wait for that computer's approval of their exact launch.
   */
  async installPackage(input: {
    readonly actorUserId: UserId;
    readonly authorize?: (() => Promise<void>) | undefined;
    readonly directory: string;
    readonly registration: LocalServerRegistration;
    readonly threadId?: ThreadId | undefined;
    readonly requestId: string;
    readonly runnerId: RunnerId | undefined;
  }): Promise<{
    readonly installation: IntegrationInstallation;
    readonly issues: readonly unknown[];
  }> {
    const { store, localServers } = this.#options;
    const name = input.registration.name;
    const currentPlugin = (await store.plugins.list()).find(
      (p) => p.name === name && p.installedBy === input.actorUserId,
    );
    const setupThreadId = input.threadId
      ? await store.plugins.setupThread(input.threadId)
      : undefined;
    const updating = currentPlugin !== undefined;
    const pluginId = currentPlugin?.id ?? createIntegrationId("installation");
    const previous = updating
      ? (await store.listInstallations()).find((i) => i.pluginId === pluginId)
      : undefined;
    const { computerId: _computer, folder: _folder, ...registration } = input.registration;
    const plugin = await snapshotLocalServerPackage({
      registration,
      pluginId,
      dataDirectory: `${this.#options.dataDirectory}/plugins/data`,
      directory: input.directory,
    });
    if (plugin.manifest.name === "opensteer")
      throw refused("bad_request", "The plugin name opensteer is reserved");
    const previousServers = previous
      ? (await store.localMcp.list()).filter((s) => s.installationId === previous.id)
      : [];
    const runnerId =
      plugin.servers.length > 0
        ? await localServers.pluginComputer(
            await localServers.updateComputer(input, previousServers),
          )
        : null;
    if (
      previous &&
      currentPlugin?.versions.find((v) => v.id === currentPlugin.currentVersionId)?.digest ===
        basename(plugin.root) &&
      previousServers
        .filter((s) => plugin.servers.some((next) => next.name === s.name))
        .every((s) => s.runnerId === runnerId && s.status !== "disabled")
    ) {
      if (setupThreadId !== undefined) {
        await input.authorize?.();
        await store.plugins.recordSetupThread(pluginId, setupThreadId);
        await localServers.requestLocalServerApprovals();
        await this.#options.onSettingsChanged({ installationId: previous.id });
      }
      return { installation: previous, issues: plugin.issues };
    }
    const servers =
      runnerId === null
        ? []
        : plugin.servers.map((server) =>
            pendingLocalServer(server, runnerId, basename(plugin.root), pluginId),
          );
    const version = {
      ...(setupThreadId !== undefined ? { setupThreadId } : {}),
      digest: basename(plugin.root),
      manifest: {
        ...plugin.manifest,
        skills: plugin.skills.map(({ name, description, digest }) => ({
          name,
          description,
          digest,
        })),
      },
    };
    const mutation = await store.install({
      beforeInstall: async (transaction) => {
        await input.authorize?.();
        if (updating)
          await store.plugins.update(
            { pluginId, source: { directory: input.directory }, ...version },
            transaction,
          );
        else
          await store.plugins.install(
            {
              id: pluginId,
              name: plugin.manifest.name,
              actorUserId: input.actorUserId,
              source: { directory: input.directory },
              ...version,
            },
            transaction,
          );
      },
      retainedServer: (existing, discovered) => localServers.retainedServer(existing, discovered),
      actorUserId: input.actorUserId,
      installation: {
        pluginId,
        description: plugin.manifest.description ?? "",
        id: previous?.id ?? createIntegrationId("installation"),
        manifest: plugin.manifest,
        name: `plugin-${pluginId.replaceAll("_", "-")}`,
        provenance: {
          snapshotDigest: basename(plugin.root),
          standard: "agent-plugins/1.0.0",
        },
        sourceKind: "plugin",
        // A server waiting for its computer's approval is not broken.
        status: servers.length > 0 || plugin.skills.length > 0 ? "active" : "needs-attention",
        title: pluginDeviceFromManifest(plugin.manifest)?.name ?? plugin.manifest.name,
        trust: "administrator-approved",
        version: null,
      },
      requestId: input.requestId,
      servers,
    });
    await this.#options.onSettingsChanged({ installationId: mutation.installation.id });
    this.#publish(mutation.requestEvents);
    localServers.clients.invalidateInstallation(mutation.installation.id);
    const installation = mutation.installation;
    if (runnerId !== null) {
      await localServers.requestLocalServerApprovals();
      // Installed again as it was, a server keeps its computer's approval and
      // is listed again now rather than when that computer next reconnects.
      localServers.startApprovedServers((server) => server.installationId === installation.id);
    }
    return { installation, issues: plugin.issues };
  }

  /** Uninstalls one installation, ending its computers' sessions and dropping its MCP clients. */
  async uninstall(input: {
    readonly actorUserId: UserId;
    readonly authorize?: (() => Promise<void>) | undefined;
    readonly installationId: IntegrationInstallationId;
    readonly requestId: string;
  }) {
    const { store, devices } = this.#options;
    const runnerIds = await store.listComputerRunnerIdsForInstallation(input.installationId);
    const mutation = await devices.withRunnerAdmissions(runnerIds, async () => {
      await input.authorize?.();
      const removed = await store.uninstall(input);
      devices.endSessionsForRemovedApps(removed.removedApps);
      return removed;
    });
    this.#publish(mutation.requestEvents);
    for (const serverId of mutation.removedServerIds) {
      await this.#options.onProviderRemoved?.(input.actorUserId, `app_server_${serverId}`);
      this.#options.localServers.clients.dropServer(serverId);
    }
    this.#options.onConnectionsChanged();
  }

  #publish(events: readonly AgentEvent[]) {
    for (const event of events) this.#options.onDeploymentEvent(event);
    if (events.length > 0) this.#options.onRequestsChanged();
  }
}

/** How the engine addresses a namespace in programs: a hyphenated name needs brackets. */
function toolsPath(name: string): string {
  return /^[a-z_$][a-z0-9_$]*$/u.test(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`;
}
