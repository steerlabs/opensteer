import { Readable } from "node:stream";
import { z } from "zod";
import type { IntegrationPlatformStore, OpensteerStore } from "@opensteer/database";
import { type RunnerId, RunnerIdSchema } from "@opensteer/core";
import type { LocalMcpLaunch } from "@opensteer/integration-core/local-mcp";
import type { IntegrationServerId } from "@opensteer/integration-core/ids";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import { SignedTokenClaimsSchema, type SignedTokenService } from "../identity/host-keys.js";
import { join } from "node:path";
import { readVerifiedPluginSnapshot } from "@opensteer/agent-plugins";
import { agentGrantAccess, OpensteerError } from "@opensteer/core";
import type { RunCapabilityTokenService } from "../agents/run-capability.js";

export type PluginPackagesTokenService = RunCapabilityTokenService<"opensteer-plugin-packages">;
const computerClaims = SignedTokenClaimsSchema.extend({
  aud: z.literal("computer-plugin-package"),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  serverId: z.string(),
  runnerId: RunnerIdSchema,
  launchDigest: z.string(),
});
type PackageScope = Awaited<ReturnType<PluginPackagesTokenService["authenticate"]>>;
/**
 * A Run's package download under its connection's current grant: the Run must still be admitted,
 * and a selected grant must still reach the installed plugin that has this digest.
 */
export function packageStillGranted(options: {
  readonly store: Pick<OpensteerStore, "admitExecution">;
  readonly installed: (
    ownerUserId: PackageScope["requestedBy"],
  ) => Promise<readonly { readonly id: string; readonly digest: string }[]>;
}) {
  return async (scope: PackageScope, digest: string): Promise<boolean> => {
    const execution = await options.store
      .admitExecution({
        ownerUserId: scope.requestedBy,
        subject: { kind: "binding", bindingId: `run:${scope.runId}` },
      })
      .catch(() => null);
    if (!execution) return false;
    const grant = execution.agentConnection?.grant;
    if (grant?.scope !== "selected") return true;
    return (await options.installed(scope.requestedBy)).some(
      (plugin) =>
        plugin.digest === digest &&
        agentGrantAccess(grant, {
          kind: "plugin",
          target: { kind: "installed", pluginId: plugin.id },
        }) !== null,
    );
  };
}
export class PluginPackageService {
  readonly #computer:
    { tokens: SignedTokenService; store: IntegrationPlatformStore; publicUrl: URL } | undefined;
  readonly #directory: string;
  readonly #tokens: PluginPackagesTokenService;
  readonly #stillGranted: (scope: PackageScope, digest: string) => Promise<boolean>;
  constructor(options: {
    snapshotDirectory: string;
    tokens: PluginPackagesTokenService;
    computer?: { tokens: SignedTokenService; store: IntegrationPlatformStore; publicUrl: URL };
    /** Whether the Run may still read this package under its connection's current grant. */
    stillGranted?: (scope: PackageScope, digest: string) => Promise<boolean>;
  }) {
    this.#computer = options.computer;
    this.#directory = options.snapshotDirectory;
    this.#tokens = options.tokens;
    this.#stillGranted = options.stillGranted ?? (async () => true);
  }
  computerSource(serverId: IntegrationServerId, runnerId: RunnerId, launch: LocalMcpLaunch) {
    if (!this.#computer || !launch.packageDigest) return undefined;
    return {
      url: new URL(
        `/internal/v1/computer-plugin-packages/${launch.packageDigest}`,
        this.#computer.publicUrl,
      ).toString(),
      token: this.#computer.tokens.issue(
        {
          aud: "computer-plugin-package",
          serverId,
          runnerId,
          digest: launch.packageDigest,
          launchDigest: localMcpLaunchDigest(launch),
        },
        300,
      ),
    };
  }
  async computerSnapshot(token: string, digest: string) {
    if (!this.#computer) throw new Error("Computer package delivery unavailable");
    const claims = this.#computer.tokens.verify(token, computerClaims);
    const server = await this.#computer.store.localMcp.get(claims.serverId as IntegrationServerId);
    if (
      claims.digest !== digest ||
      !server ||
      server.status === "disabled" ||
      server.runnerId !== claims.runnerId ||
      server.launchDigest !== claims.launchDigest ||
      server.approvedLaunchDigest !== claims.launchDigest
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Package launch is not approved on this computer",
      });
    return this.#files(digest);
  }
  async #files(digest: string) {
    const files = await readVerifiedPluginSnapshot(join(this.#directory, digest), digest);
    return files.map(({ path, mode, bytes }) => ({
      path,
      mode,
      content: bytes.toString("base64"),
    }));
  }
  async stream(token: string, digest: string, computer = false) {
    const files = computer
      ? await this.computerSnapshot(token, digest)
      : await this.snapshot(token, digest);
    return Readable.from(
      (function* () {
        yield "[";
        for (let index = 0; index < files.length; index += 1) {
          if (index) yield ",";
          yield JSON.stringify(files[index]);
        }
        yield "]";
      })(),
    );
  }
  async snapshot(token: string, digest: string) {
    const scope = await this.#tokens.authenticate(token);
    if (
      !/^[a-f0-9]{64}$/u.test(digest) ||
      !scope.pluginDigests?.includes(digest) ||
      !(await this.#stillGranted(scope, digest))
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Package is not pinned to this Run" });
    }
    return this.#files(digest);
  }
}
