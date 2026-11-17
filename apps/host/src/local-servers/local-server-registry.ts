import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPluginManifestSchemaUrl, agentPluginMcpSchemaUrl } from "@opensteer/agent-plugins";
import { OpensteerError, type RunnerId, type ThreadId, type UserId } from "@opensteer/core";
import { pluginDeviceFromManifest } from "@opensteer/integration-core";
import type { IntegrationPlatformService } from "../integrations/integration-platform-service.js";
import { withFolderPluginPackage } from "../integrations/folder-plugin-package.js";
import type { AgentHomeFiles } from "../threads/agent-home-files.js";
import type { LocalServerService } from "./local-server-service.js";

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
    readonly platform: Pick<
      IntegrationPlatformService,
      "installAgentPlugin" | "uninstallIntegration" | "store"
    >;
    readonly localServers: Pick<LocalServerService, "removePluginData">;
    readonly files: () => Promise<Pick<AgentHomeFiles, "list" | "download">>;
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
  ) {
    const extension = {
      ...(input.device ? { device: input.device } : {}),
      ...(input.launch?.secrets ? { secrets: { [input.name]: input.launch.secrets } } : {}),
    };
    const manifest = {
      $schema: agentPluginManifestSchemaUrl,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(Object.keys(extension).length ? { extensions: { "com.opensteer": extension } } : {}),
    };
    const mcp = {
      $schema: agentPluginMcpSchemaUrl,
      mcpServers: {
        [input.name]: input.launch
          ? {
              type: "stdio",
              command: input.launch.command,
              ...(input.launch.args ? { args: input.launch.args } : {}),
              ...(input.launch.env ? { env: input.launch.env } : {}),
              ...(input.launch.cwd ? { cwd: input.launch.cwd } : {}),
            }
          : { type: "streamable-http", url: input.url },
      },
    };
    const install = async (directory: string) => {
      await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
      await writeFile(join(directory, "mcp.json"), JSON.stringify(mcp));
      return this.#options.platform.installAgentPlugin({
        actorUserId: actor.userId,
        directory,
        threadId: actor.threadId,
        requestId,
        ...(input.computerId ? { runnerId: input.computerId } : {}),
      });
    };
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
    const store = this.#options.platform.store;
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
            path: toolsPath(plugin.name),
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

  async remove(actor: { readonly userId: UserId }, name: string, requestId: string) {
    const store = this.#options.platform.store;
    const plugin = (await store.plugins.list()).find(
      (candidate) => candidate.name === name && candidate.installedBy === actor.userId,
    );
    if (!plugin)
      throw new OpensteerError({
        code: "not_found",
        message: `No local server is named ${name}.`,
        next: "Use local_server_list for the registered names.",
      });
    await store.plugins.assertCanRemove(plugin.id, actor);
    for (const installation of await store.listInstallations())
      if (installation.pluginId === plugin.id)
        await this.#options.platform.uninstallIntegration({
          installationId: installation.id,
          actorUserId: actor.userId,
          requestId,
        });
    await store.plugins.remove(plugin.id);
    await this.#options.localServers.removePluginData(plugin.id);
  }
}

/** How the engine addresses a namespace in programs: a hyphenated name needs brackets. */
function toolsPath(name: string): string {
  return /^[a-z_$][a-z0-9_$]*$/u.test(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`;
}
