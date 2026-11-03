import { Readable } from "node:stream";
import { z } from "zod";
import type { IntegrationPlatformStore } from "@opensteer/database";
import { type RunnerId, RunnerIdSchema } from "@opensteer/core";
import type { LocalMcpLaunch, IntegrationServerId } from "@opensteer/integration-core";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import { SignedTokenClaimsSchema, type SignedTokenService } from "../identity/host-keys.js";
import { join } from "node:path";
import { pluginSnapshotDigest, readPluginSnapshot } from "@opensteer/agent-plugins";
import { OpensteerError } from "@opensteer/core";
import type { RunCapabilityTokenService } from "../agents/run-capability.js";

export type PluginPackagesTokenService = RunCapabilityTokenService<"opensteer-plugin-packages">;
const computerClaims = SignedTokenClaimsSchema.extend({
  aud: z.literal("computer-plugin-package"),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  serverId: z.string(),
  runnerId: RunnerIdSchema,
  launchDigest: z.string(),
});
export class PluginPackageService {
  readonly #computer:
    { tokens: SignedTokenService; store: IntegrationPlatformStore; publicUrl: URL } | undefined;
  readonly #directory: string;
  readonly #tokens: PluginPackagesTokenService;
  constructor(options: {
    snapshotDirectory: string;
    tokens: PluginPackagesTokenService;
    computer?: { tokens: SignedTokenService; store: IntegrationPlatformStore; publicUrl: URL };
  }) {
    this.#computer = options.computer;
    this.#directory = options.snapshotDirectory;
    this.#tokens = options.tokens;
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
    const files = await readPluginSnapshot(join(this.#directory, digest));
    if (pluginSnapshotDigest(files) !== digest) throw new Error("Plugin snapshot digest mismatch");
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
    if (!/^[a-f0-9]{64}$/u.test(digest) || !scope.pluginDigests?.includes(digest)) {
      throw new OpensteerError({ code: "forbidden", message: "Package is not pinned to this Run" });
    }
    return this.#files(digest);
  }
}
