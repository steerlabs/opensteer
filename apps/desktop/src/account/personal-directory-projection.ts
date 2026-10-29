import type { AccountDeploymentDirectoryEntry } from "@opensteer/control-plane-protocol";
import type { AccountDeploymentConnectionSource } from "@opensteer/client/connections";
import type { DesktopPersonalAccountLinkStore } from "./personal-account-link-store.js";
import { PersonalRemoteAccessStatusSchema } from "@opensteer/protocol";
import type { NativePersonalRemoteHostControl } from "../supervisor/personal-host-control.js";
import { DesktopPersonalAccountMutationCoordinator } from "./personal-account-mutation.js";
import type { PersonalDeploymentFilesystemPort } from "../secrets/personal-deployment-store.js";
import type { PersonalHostRuntimeSource } from "../supervisor/personal-host-runtime.js";

/** Projects Account directory naming onto the matching local Personal Host. */
export class DesktopPersonalDirectoryProjection {
  readonly #host: Pick<NativePersonalRemoteHostControl, "status">;
  readonly #links: Pick<DesktopPersonalAccountLinkStore, "inspect">;
  readonly #manifest: Pick<PersonalDeploymentFilesystemPort, "load" | "save">;
  readonly #mutations: DesktopPersonalAccountMutationCoordinator;
  readonly #runtime: PersonalHostRuntimeSource;

  constructor(options: {
    readonly host: Pick<NativePersonalRemoteHostControl, "status">;
    readonly links: Pick<DesktopPersonalAccountLinkStore, "inspect">;
    readonly manifest: Pick<PersonalDeploymentFilesystemPort, "load" | "save">;
    readonly mutations: DesktopPersonalAccountMutationCoordinator;
    readonly runtime: PersonalHostRuntimeSource;
  }) {
    this.#host = options.host;
    this.#links = options.links;
    this.#manifest = options.manifest;
    this.#mutations = options.mutations;
    this.#runtime = options.runtime;
  }

  project(
    deployment: AccountDeploymentDirectoryEntry,
    source: AccountDeploymentConnectionSource,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#mutations.run("background", async () => {
      signal.throwIfAborted();
      if (deployment.lifecycle !== "active" || deployment.reachability !== "routed") return;
      const runtime = await this.#runtime.current();
      signal.throwIfAborted();
      if (!runtime || runtime.discovery.deploymentId !== deployment.id) return;
      let hostStatus;
      let reconciliation: Awaited<ReturnType<DesktopPersonalAccountLinkStore["inspect"]>>;
      try {
        hostStatus = PersonalRemoteAccessStatusSchema.parse(await this.#host.status(runtime));
        signal.throwIfAborted();
        reconciliation = await this.#links.inspect(deployment.id, runtime, hostStatus.accountLink);
      } catch {
        // This projection is local, best-effort metadata maintenance. A Host
        // transport or protected-journal failure cannot turn linked into
        // unlinked, and it must not prevent the Account directory from
        // reconciling unrelated Deployments.
        signal.throwIfAborted();
        return;
      }
      signal.throwIfAborted();
      if (
        reconciliation.status === "needs-repair" ||
        reconciliation.journal?.unlinkOperation ||
        !hostStatus.accountLink ||
        hostStatus.accountLink.issuer !== source.issuer ||
        hostStatus.accountLink.subject !== source.subject ||
        deployment.accountLink?.issuer !== source.issuer ||
        deployment.accountLink.subject !== source.subject ||
        deployment.accountLink.generation !== hostStatus.accountLink.generation
      ) {
        return;
      }
      const manifest = await this.#manifest.load();
      signal.throwIfAborted();
      if (!manifest || manifest.deploymentId !== deployment.id) return;
      if (manifest.name !== deployment.name) {
        await this.#manifest.save(manifest, {
          ...manifest,
          name: deployment.name,
          revision: manifest.revision + 1,
          updatedAt: new Date().toISOString(),
        });
      }
    });
  }
}
