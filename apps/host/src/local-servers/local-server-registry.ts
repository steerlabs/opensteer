import { localNamespace, slugify } from "../plugins/provider-names.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pluginPackageFormat, snapshotLocalServerPackage } from "@opensteer/agent-plugins";
import {
  OpensteerError,
  refused,
  type DeviceId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { local_server_add } from "@opensteer/agent-tools/tools";
import { fingerprint } from "../mcp/operations.js";
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
import {
  localServerStatus,
  pendingLocalServer,
  type LocalServerService,
} from "./local-server-service.js";

const registrationResult = local_server_add.output.required({ server: true });

export interface LocalServerRegistration {
  readonly name: string;
  readonly description?: string | undefined;
  readonly computerId?: DeviceId | undefined;
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
    readonly devices: Pick<DeviceService, "endSessionsForRemovedApps" | "withDeviceAdmissions">;
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
    const store = this.#options.store;
    const administration = {
      ...serverAdministration(actor.userId, requestId, "local-server.add", input),
      output: (result: unknown) => (result as { registration: unknown }).registration,
    };
    const replay = await store.replayAdministration(administration);
    if (replay) return registrationResult.parse(replay.output);
    const runnerId = input.computerId
      ? await this.#options.store.getDeviceSelfRunnerId(input.computerId)
      : undefined;
    if (runnerId === null)
      throw refused(
        "bad_request",
        "Local servers need a computer with its own Runner. A screen-only Device cannot run a server.",
      );
    const install = (directory: string) =>
      this.installPackage({
        actorUserId: actor.userId,
        administration,
        authorize,
        directory,
        registration: input,
        threadId: actor.threadId,
        requestId,
        runnerId,
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
    if (!result.registration) throw new Error("Local server registration receipt is missing");
    return result.registration;
  }

  /** `visible` scopes the servers before anything about them is projected. */
  async list(
    owner: UserId,
    store = this.#options.store,
    visible: (serverId: string) => boolean = () => true,
  ) {
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
          .filter(({ id, installationId }) => installationId === installation?.id && visible(id))
          .map((server) => {
            const { state, detail } = localServerStatus(server);
            return {
              name: plugin.name,
              pluginId: plugin.id,
              path: toolsPath(localNamespace(slugify(plugin.name), `app_server_${server.id}`)),
              computer: server.runnerName,
              computerId: server.deviceId,
              kind: server.launch.type === "stdio" ? ("program" as const) : ("loopback" as const),
              state,
              ...(detail ? { detail } : {}),
              ...(device ? { device } : {}),
            };
          });
      });
  }

  async remove(
    actor: { readonly userId: UserId },
    name: string,
    requestId: string,
    authorize?: () => Promise<void>,
  ) {
    const store = this.#options.store;
    const administration = serverAdministration(actor.userId, requestId, "local-server.remove", {
      name,
    });
    const replay = await store.replayAdministration(administration);
    if (replay) return { ok: true as const };
    const plugin = (await store.plugins.list()).find(
      (candidate) => candidate.name === name && candidate.installedBy === actor.userId,
    );
    if (!plugin && (await store.replayAdministration(administration))) return { ok: true as const };
    if (!plugin)
      throw new OpensteerError({
        code: "not_found",
        message: `No local server is named ${name}.`,
        next: "Use local_server_list for the registered names.",
      });
    await this.removePlugin(actor, plugin.id, requestId, administration, authorize);
    return { ok: true as const };
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
    if (administration && (await store.replayAdministration(administration))) return;
    const installations = await store.installationsForPlugin(pluginId);
    const devices = (
      await Promise.all(installations.map(({ id }) => this.#installationDevices(id)))
    ).flat();
    const removed = await this.#options.devices.withDeviceAdmissions(devices, async () => {
      const { result, applied } = await store.administer(administration, async (scoped) => {
        await scoped.plugins.assertCanRemove(pluginId, actor);
        await authorize?.();
        // Plugin writes precede installation locks, as they do on install and update.
        await scoped.plugins.remove(pluginId);
        const changes = [];
        for (const installation of installations)
          changes.push(
            await scoped.uninstall({
              installationId: installation.id,
              actorUserId: actor.userId,
              requestId,
            }),
          );
        return { pluginId, changes };
      });
      if (!applied) return;
      for (const change of result.changes)
        await this.#options.devices.endSessionsForRemovedApps(change.removedApps);
      return result.changes;
    });
    if (!removed) return;
    for (const change of removed) await this.#notifyUninstalled(actor.userId, change);
    await this.#options.localServers.removePluginData(pluginId);
  }

  /**
   * Installs, or updates by name for the same person, the registered package: its
   * servers wait for that computer's approval of their exact launch.
   */
  async installPackage(input: {
    readonly actorUserId: UserId;
    readonly administration?: AdministrationCommandIdentity;
    readonly authorize?: (() => Promise<void>) | undefined;
    readonly directory: string;
    readonly registration: LocalServerRegistration;
    readonly threadId?: ThreadId | undefined;
    readonly requestId: string;
    readonly runnerId: RunnerId | undefined;
  }): Promise<{
    readonly installation: IntegrationInstallation;
    readonly issues: readonly unknown[];
    readonly registration?: ReturnType<typeof registrationResult.parse> | undefined;
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
    // A first registration's id is chosen here; if another of the same name commits first, the
    // database keeps that one and this registration is refused inside its transaction.
    const pluginId = currentPlugin?.id ?? createIntegrationId("installation");
    const previous = updating ? (await store.installationsForPlugin(pluginId))[0] : undefined;
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
    const unchanged =
      previous &&
      currentPlugin?.versions.find((v) => v.id === currentPlugin.currentVersionId)?.digest ===
        basename(plugin.root) &&
      previousServers
        .filter((s) => plugin.servers.some((next) => next.name === s.name))
        .every((s) => s.runnerId === runnerId && s.status !== "disabled")
        ? previous
        : undefined;
    const servers =
      runnerId === null
        ? []
        : plugin.servers.map((server) =>
            pendingLocalServer(server, runnerId, basename(plugin.root), pluginId),
          );
    const version = {
      ...(setupThreadId !== undefined ? { setupThreadId } : {}),
      digest: basename(plugin.root),
      packageFormat: pluginPackageFormat,
      manifest: {
        ...plugin.manifest,
        skills: plugin.skills.map(({ name, description, digest }) => ({
          name,
          description,
          digest,
        })),
      },
    };
    const persist = async (scoped: IntegrationPlatformStore) => {
      const mutation = unchanged
        ? await (async () => {
            if (setupThreadId !== undefined) {
              await input.authorize?.();
              await scoped.plugins.recordSetupThread(pluginId, setupThreadId);
            }
            return { installation: unchanged };
          })()
        : await scoped.install({
            beforeInstall: async (transaction) => {
              await input.authorize?.();
              if (updating)
                await scoped.plugins.update(
                  { pluginId, source: { directory: input.directory }, ...version },
                  transaction,
                );
              else
                await scoped.plugins.install(
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
            retainedServer: (existing, discovered) =>
              localServers.retainedServer(existing, discovered),
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
      const registration = input.administration
        ? await this.#registrationResult(scoped, input.actorUserId, pluginId, name, plugin.issues)
        : undefined;
      return { ...mutation, registration };
    };
    const { result: mutation, applied } = input.administration
      ? await store.administer(input.administration, persist)
      : { result: await persist(store), applied: true };
    if (applied && (!unchanged || setupThreadId !== undefined)) {
      if (!unchanged) {
        await this.#options.onSettingsChanged({ installationId: mutation.installation.id });
        localServers.clients.invalidateInstallation(mutation.installation.id);
      }
      if (runnerId !== null) {
        await localServers.requestLocalServerApprovals();
        if (!unchanged)
          localServers.startApprovedServers(
            (server) => server.installationId === mutation.installation.id,
          );
      }
      if (unchanged)
        await this.#options.onSettingsChanged({ installationId: mutation.installation.id });
    }
    return {
      installation: mutation.installation,
      issues: plugin.issues,
      registration: mutation.registration,
    };
  }

  async #registrationResult(
    store: IntegrationPlatformStore,
    owner: UserId,
    pluginId: string,
    name: string,
    rawIssues: readonly unknown[],
  ) {
    const issues = rawIssues.map((issue) =>
      typeof issue === "object" && issue !== null && "message" in issue
        ? String(issue.message)
        : String(issue),
    );
    const server = (await this.list(owner, store)).find((entry) => entry.pluginId === pluginId);
    if (!server)
      throw new OpensteerError({
        code: "bad_request",
        message: `${name} was not registered: ${issues.join(" ") || "its launch is invalid"}`,
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

  /** Uninstalls one installation, ending its computers' sessions and dropping its MCP clients. */
  async uninstall(input: {
    readonly actorUserId: UserId;
    readonly authorize?: (() => Promise<void>) | undefined;
    readonly installationId: IntegrationInstallationId;
    readonly requestId: string;
  }) {
    const { store, devices } = this.#options;
    const mutation = await devices.withDeviceAdmissions(
      await this.#installationDevices(input.installationId),
      async () => {
        await input.authorize?.();
        const removed = await store.uninstall(input);
        await devices.endSessionsForRemovedApps(removed.removedApps);
        return removed;
      },
    );
    await this.#notifyUninstalled(input.actorUserId, mutation);
  }

  async #installationDevices(installationId: IntegrationInstallationId) {
    const store = this.#options.store;
    const [apps, servers] = await Promise.all([
      store.listComputerDeviceIdsForInstallation(installationId),
      store.localMcp.list(installationId),
    ]);
    return [...apps, ...servers.flatMap(({ deviceId }) => (deviceId === null ? [] : [deviceId]))];
  }

  async #notifyUninstalled(
    owner: UserId,
    mutation: Awaited<ReturnType<IntegrationPlatformStore["uninstall"]>>,
  ) {
    for (const serverId of mutation.removedServerIds) {
      await this.#options.onProviderRemoved?.(owner, `app_server_${serverId}`);
      this.#options.localServers.clients.dropServer(serverId);
    }
    this.#options.onConnectionsChanged();
  }
}

/** How the engine addresses a namespace in programs: a hyphenated name needs brackets. */
function toolsPath(name: string): string {
  return /^[a-z_$][a-z0-9_$]*$/u.test(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`;
}

function serverAdministration(
  owner: UserId,
  idempotencyKey: string,
  type: "local-server.add" | "local-server.remove",
  request: LocalServerRegistration | { readonly name: string },
): AdministrationCommandIdentity {
  return {
    type,
    idempotencyKey,
    requestedBy: owner,
    request: { fingerprint: fingerprint(request) },
    authoritySource: { kind: "agent" },
  };
}
