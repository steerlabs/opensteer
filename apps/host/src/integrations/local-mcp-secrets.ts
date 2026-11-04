import type { AesGcmSecretVault } from "@opensteer/access/host";
import { OpensteerError } from "@opensteer/core";
import {
  LocalMcpSecretValueSchema,
  localMcpLaunchSecrets,
  type IntegrationServerId,
  type LocalMcpLaunch,
} from "@opensteer/integration-core";
import type { LocalMcpSecretsUpdate } from "@opensteer/database";

/**
 * The secrets an MCP server's launch declares, as the owner of the computer
 * that runs it entered them (`docs/computers.md`, "MCP servers on a
 * computer"). Sealed per server; opened only to start that server.
 */
export class LocalMcpSecrets {
  readonly #vault: Pick<AesGcmSecretVault, "open" | "seal">;

  constructor(vault: Pick<AesGcmSecretVault, "open" | "seal">) {
    this.#vault = vault;
  }

  /**
   * Keeps what is stored for each declared secret the owner left blank,
   * takes what they entered for the rest, and drops values for secrets the
   * launch no longer declares. Every declared secret ends with a value.
   */
  update(
    serverId: IntegrationServerId,
    launch: LocalMcpLaunch,
    entered: Readonly<Record<string, string>>,
  ): LocalMcpSecretsUpdate {
    const declared = localMcpLaunchSecrets(launch);
    for (const name of Object.keys(entered)) {
      if (!declared.some((secret) => secret.name === name))
        throw new OpensteerError({
          code: "bad_request",
          message: `This server doesn't ask for ${name}.`,
        });
    }
    for (const { name, title } of declared) {
      const value = entered[name];
      const parsed = value === undefined ? null : LocalMcpSecretValueSchema.safeParse(value);
      if (parsed && !parsed.success)
        throw new OpensteerError({
          code: "bad_request",
          message: `${title}: ${parsed.error.issues[0]?.message ?? "Invalid value"}`,
        });
    }
    return async (current) => {
      if (declared.length === 0) return null;
      const stored = current ? await this.open(serverId, current) : {};
      const next: Record<string, string> = {};
      for (const { name, title } of declared) {
        const value = entered[name] ?? stored[name];
        if (value === undefined)
          throw new OpensteerError({
            code: "bad_request",
            message: `Enter ${title}. If there's no field for it, update Opensteer on this device.`,
          });
        next[name] = value;
      }
      return (await this.#vault.seal(next, context(serverId))).envelope;
    };
  }

  prune(serverId: IntegrationServerId, launch: LocalMcpLaunch): LocalMcpSecretsUpdate {
    return async (current) => {
      if (!current) return null;
      const stored = await this.open(serverId, current);
      const next = Object.fromEntries(
        localMcpLaunchSecrets(launch).flatMap(({ name }) =>
          stored[name] === undefined ? [] : [[name, stored[name]]],
        ),
      );
      return Object.keys(next).length
        ? (await this.#vault.seal(next, context(serverId))).envelope
        : null;
    };
  }

  /** Which declared secrets have a value stored. */
  async saved(
    serverId: IntegrationServerId,
    launch: LocalMcpLaunch,
    sealed: Buffer | null,
  ): Promise<string[]> {
    if (sealed === null) return [];
    const stored = await this.open(serverId, sealed);
    return localMcpLaunchSecrets(launch)
      .map(({ name }) => name)
      .filter((name) => Object.hasOwn(stored, name));
  }

  /** The values a server is started with, by environment variable name. */
  async values(
    serverId: IntegrationServerId,
    launch: LocalMcpLaunch,
    sealed: Buffer | null,
  ): Promise<Readonly<Record<string, string>>> {
    const declared = localMcpLaunchSecrets(launch);
    if (declared.length === 0) return {};
    const stored = sealed ? await this.open(serverId, sealed) : {};
    const missing = declared.filter(({ name }) => !Object.hasOwn(stored, name));
    if (missing.length > 0)
      throw new OpensteerError({
        code: "conflict",
        message: `${missing.map(({ title }) => title).join(", ")} isn't set. Its computer's owner can enter it in Settings, Plugins.`,
      });
    return Object.fromEntries(declared.map(({ name }) => [name, stored[name]!]));
  }

  open(serverId: IntegrationServerId, sealed: Buffer): Promise<Readonly<Record<string, string>>> {
    return this.#vault.open(sealed, context(serverId));
  }
}

function context(serverId: IntegrationServerId) {
  return { purpose: "local-mcp-server-secrets", recordId: serverId, scope: "integration-server" };
}
