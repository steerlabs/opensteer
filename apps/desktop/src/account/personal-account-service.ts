import {
  DesktopPersonalAccountLinkStatusSchema,
  type DesktopPersonalAccountLinkStatus,
} from "@opensteer/protocol/desktop";
import { PersonalRemoteAccessStatusSchema } from "@opensteer/protocol";
import { ConnectOperationIdSchema } from "@opensteer/control-plane-protocol";
import type { AccountDeploymentDirectoryService } from "@opensteer/client/connections";
import type { DesktopPersonalAccountLinkCoordinator } from "./personal-account-link.js";
import {
  emptyPersonalAccountLinkJournal,
  type DesktopPersonalAccountLinkState,
  type DesktopPersonalAccountLinkStore,
  type PersonalAccountUnlinkStep,
} from "./personal-account-link-store.js";
import {
  isGeneratedPersonalDeploymentName,
  type PersonalDeploymentFilesystemPort,
} from "../secrets/personal-deployment-store.js";
import type { DesktopPersonalHostRemoteAdapter } from "../supervisor/personal-host-remote-adapter.js";
import type { PersonalHostRuntimeSource } from "../supervisor/personal-host-runtime.js";
import type { DesktopPersonalRemoteAccessService } from "../connections/personal-remote-access.js";
import { DesktopPersonalAccountMutationCoordinator } from "./personal-account-mutation.js";

const unlinkSteps = [
  "disable-connect",
  "revoke-account-sessions",
  "revoke-connect-resource",
  "remove-host-link",
  "repair-hosted-oauth-connections",
  "retain-local-data",
] as const satisfies readonly PersonalAccountUnlinkStep[];

type Listener = (status: DesktopPersonalAccountLinkStatus) => void;

type LinkAccount = { readonly issuer: string; readonly subject: string };

/** Owner-machine controller for the durable Account-link fact. Connect remains
 * an independent intent; unlink records each externally visible boundary. */
export class DesktopPersonalAccountService {
  readonly #account: Pick<
    AccountDeploymentDirectoryService,
    "accountIdentity" | "cancelPersonalHostAccountLinkOperation" | "renamePersonalDeployment"
  >;
  readonly #host: Pick<
    DesktopPersonalHostRemoteAdapter,
    | "removeAccountLinkForUnlink"
    | "repairHostedOAuthConnectionsForUnlink"
    | "revokeAccountSessionsForUnlink"
    | "status"
  >;
  readonly #link: Pick<DesktopPersonalAccountLinkCoordinator, "ensureLinkedForMutation">;
  readonly #links: Pick<
    DesktopPersonalAccountLinkStore,
    "clear" | "inspect" | "reconcileForMutation" | "save"
  >;
  readonly #listeners = new Set<Listener>();
  readonly #manifest: Pick<PersonalDeploymentFilesystemPort, "load" | "save">;
  readonly #mutations: DesktopPersonalAccountMutationCoordinator;
  readonly #remote: Pick<
    DesktopPersonalRemoteAccessService,
    "disableConnectForUnlink" | "revokeConnectResourceForUnlink"
  >;
  readonly #runtime: PersonalHostRuntimeSource;

  constructor(options: {
    readonly account: Pick<
      AccountDeploymentDirectoryService,
      "accountIdentity" | "cancelPersonalHostAccountLinkOperation" | "renamePersonalDeployment"
    >;
    readonly host: Pick<
      DesktopPersonalHostRemoteAdapter,
      | "removeAccountLinkForUnlink"
      | "repairHostedOAuthConnectionsForUnlink"
      | "revokeAccountSessionsForUnlink"
      | "status"
    >;
    readonly link: Pick<DesktopPersonalAccountLinkCoordinator, "ensureLinkedForMutation">;
    readonly links: Pick<
      DesktopPersonalAccountLinkStore,
      "clear" | "inspect" | "reconcileForMutation" | "save"
    >;
    readonly manifest: Pick<PersonalDeploymentFilesystemPort, "load" | "save">;
    readonly mutations?: DesktopPersonalAccountMutationCoordinator;
    readonly remote: Pick<
      DesktopPersonalRemoteAccessService,
      "disableConnectForUnlink" | "revokeConnectResourceForUnlink"
    >;
    readonly runtime: PersonalHostRuntimeSource;
  }) {
    this.#account = options.account;
    this.#host = options.host;
    this.#link = options.link;
    this.#links = options.links;
    this.#manifest = options.manifest;
    this.#mutations = options.mutations ?? new DesktopPersonalAccountMutationCoordinator();
    this.#remote = options.remote;
    this.#runtime = options.runtime;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  status(): Promise<DesktopPersonalAccountLinkStatus> {
    return this.#readStatus();
  }

  async #readStatus(): Promise<DesktopPersonalAccountLinkStatus> {
    const runtime = await this.#runtime.current();
    if (!runtime) return parseStatus({ status: "unavailable" });
    const manifest = await this.#manifest.load();
    let hostStatus;
    try {
      hostStatus = PersonalRemoteAccessStatusSchema.parse(await this.#host.status());
    } catch {
      return parseStatus({
        deploymentId: runtime.discovery.deploymentId,
        displayName: manifest?.name ?? null,
        status: "unavailable",
      });
    }
    // Status is a projection, never a write: `inspect` reports repair for a
    // corrupt, undecryptable, or authority-mismatched journal and leaves the
    // evidence in place. `resetLinkJournal` is the exit from that state.
    const reconciliation = await this.#links.inspect(
      runtime.discovery.deploymentId,
      runtime,
      hostStatus.accountLink,
    );
    const state = reconciliation.journal;
    const account = hostStatus.accountLink
      ? { issuer: hostStatus.accountLink.issuer, subject: hostStatus.accountLink.subject }
      : null;
    if (reconciliation.status === "needs-repair") {
      return parseStatus({
        account,
        deploymentId: runtime.discovery.deploymentId,
        displayName: manifest?.name ?? null,
        status: "needs-repair",
      });
    }
    if (state?.unlinkOperation) {
      return parseStatus({
        account,
        deploymentId: runtime.discovery.deploymentId,
        displayName: manifest?.name ?? null,
        status: "unlinking",
        unlinkStep: nextUnlinkStep(state),
      });
    }
    if (
      state?.issueOperationId ||
      state?.operation ||
      hostStatus.accountLink?.state === "activating"
    ) {
      const activating = hostStatus.accountLink ?? state?.operation?.challenge.account ?? null;
      return parseStatus({
        account: activating ? { issuer: activating.issuer, subject: activating.subject } : null,
        deploymentId: runtime.discovery.deploymentId,
        displayName: manifest?.name ?? null,
        status: "activating",
      });
    }
    if (!hostStatus.accountLink) {
      return parseStatus({
        deploymentId: runtime.discovery.deploymentId,
        displayName: manifest?.name ?? null,
        status: "unlinked",
      });
    }
    const current = await this.#account.accountIdentity();
    const sameAccount =
      current?.issuer === hostStatus.accountLink.issuer &&
      current.subject === hostStatus.accountLink.subject;
    return parseStatus({
      account: !current || sameAccount ? account : null,
      deploymentId: runtime.discovery.deploymentId,
      displayName: manifest?.name ?? null,
      status: current && !sameAccount ? "linked-elsewhere" : "linked",
    });
  }

  link(): Promise<DesktopPersonalAccountLinkStatus> {
    return this.#mutations.run("link", async () => {
      await this.#link.ensureLinkedForMutation();
      return this.#publish();
    });
  }

  /**
   * Finishes an activation a crash or a lost response left half-done, without
   * making the owner discover it. Activation is resumable from the Host's row
   * alone, so this needs nothing but a signed-in Account that matches the link
   * being activated — a different Account has no business completing it, and a
   * signed-out one has no bearer to try with. It returns null when there is
   * nothing to resume. Exactly one attempt: the caller reports a failure and
   * leaves the link where it is, because a Host that refuses once here will
   * refuse again for the same reason, and the owner still has Link and Unlink.
   */
  async resumeActivatingLink(): Promise<DesktopPersonalAccountLinkStatus | null> {
    const runtime = await this.#runtime.current();
    if (!runtime) return null;
    const hostStatus = PersonalRemoteAccessStatusSchema.parse(await this.#host.status());
    const link = hostStatus.accountLink;
    if (link?.state !== "activating") return null;
    const current = await this.#account.accountIdentity();
    if (!current || current.issuer !== link.issuer || current.subject !== link.subject) return null;
    // The mutation coordinator owns the decision from here: a cancel already
    // queued fences this, and the link path re-reads the Host inside the lock.
    return this.link();
  }

  /**
   * Names this Personal Opensteer after the Mac it runs on — "Alex’s MacBook
   * Pro", as the owner named it in System Settings — while it still wears a
   * name Opensteer generated: the "This computer" of older releases, or the
   * network hostname a new install starts with. It goes through `rename`, so a
   * linked Account learns the new name first and nothing drifts apart. A
   * refusal (the Account is signed out, say) leaves the name alone until the
   * next launch.
   */
  async adoptComputerName(computerName: string): Promise<void> {
    const manifest = await this.#manifest.load();
    if (
      !manifest ||
      manifest.name === computerName ||
      !isGeneratedPersonalDeploymentName(manifest.name)
    ) {
      return;
    }
    await this.rename(computerName);
  }

  unlink(): Promise<DesktopPersonalAccountLinkStatus> {
    return this.#mutations.run("unlink", async () => {
      const runtime = await this.#runtime.current();
      if (!runtime) throw new Error("Start This Computer before unlinking it.");
      const deploymentId = runtime.discovery.deploymentId;
      const hostStatus = PersonalRemoteAccessStatusSchema.parse(await this.#host.status());
      const reconciliation = await this.#links.reconcileForMutation(
        deploymentId,
        runtime,
        hostStatus.accountLink,
      );
      if (reconciliation.status === "needs-repair") {
        throw new Error(
          "This Personal Host's Account link needs repair before it can be unlinked.",
        );
      }
      let state = reconciliation.journal ?? emptyPersonalAccountLinkJournal(runtime);

      if (hostStatus.accountLink?.state === "activating") {
        // Cancelling an activation is not a teardown. Every rung of the unlink
        // ladder removes access that only an *active* link can grant: the Host
        // refuses Connect, refuses the Connect projection, and refuses to
        // exchange an Account session grant while the link is activating, so
        // there is provably no Connect route, no Connect resource, and no
        // Account-brokered remote session to revoke. One call removes the link:
        // the Host cancels the central reservation under its own credential and
        // then deletes its row. Running the ladder here is what used to write
        // an unlink journal the Host could never satisfy.
        await this.#host.removeAccountLinkForUnlink();
        await this.#links.clear(deploymentId);
        return this.#publish();
      }

      if ((state.issueOperationId || state.operation) && !hostStatus.accountLink) {
        // The Host holds nothing, so this Desktop is the only party still
        // carrying the operation. Cancel the central reservation directly. A
        // saved completion changes nothing here: finishing activation only to
        // tear it down would provision a Deployment the owner just asked to
        // stop, and the reservation cancel already covers both cases.
        const operationId = state.issueOperationId ?? state.operation?.operationId;
        if (!operationId) throw new Error("Account-link journal is inconsistent.");
        await this.#account.cancelPersonalHostAccountLinkOperation(operationId);
        await this.#links.clear(deploymentId);
        return this.#publish();
      }

      if (!hostStatus.accountLink && !state.unlinkOperation) return this.#publish();

      const displayName = (await this.#manifest.load())?.name ?? null;
      const linkedAccount: LinkAccount | null = hostStatus.accountLink
        ? { issuer: hostStatus.accountLink.issuer, subject: hostStatus.accountLink.subject }
        : null;
      if (!state.unlinkOperation) {
        state = await this.#links.save(deploymentId, {
          ...state,
          operation: null,
          unlinkOperation: {
            completedSteps: [],
            connectRevokeOperationId: ConnectOperationIdSchema.parse(
              `cop_${globalThis.crypto.randomUUID()}`,
            ),
            startedAt: new Date().toISOString(),
          },
        });
        this.#publishUnlinkStep(deploymentId, displayName, linkedAccount, state);
      }
      for (const step of unlinkSteps) {
        if (state.unlinkOperation!.completedSteps.includes(step)) continue;
        await this.#runStep(step, state);
        state = await this.#links.save(deploymentId, {
          ...state,
          unlinkOperation: {
            ...state.unlinkOperation!,
            completedSteps: [...state.unlinkOperation!.completedSteps, step],
          },
        });
        // Progress is derived from the journal that was just written. Re-reading
        // the Host and the journal after every rung would cost a round trip per
        // step to learn something this loop already knows; the authoritative
        // read happens once, below, when the ladder is done.
        this.#publishUnlinkStep(deploymentId, displayName, linkedAccount, state);
      }
      await this.#links.clear(deploymentId);
      return this.#publish();
    });
  }

  /**
   * The exit from needs-repair. The journal is a crash-recovery record, not
   * authority: the Host owns the link. Discarding it is safe in every state the
   * Host can report — no link means there is nothing to finish; an active link
   * needs no journal at all; and an activating link resumes from the Host's own
   * row, which is why `link()` can drive it to active without one. What the
   * discard costs is at most a stale central reservation, which expires on its
   * own and which the Account supersedes when this Host asks for a new
   * challenge. The Host must answer a status first: without that answer this
   * Desktop cannot say the journal is unneeded, only that it cannot read it.
   */
  resetLinkJournal(): Promise<DesktopPersonalAccountLinkStatus> {
    return this.#mutations.run("background", async () => {
      const runtime = await this.#runtime.current();
      if (!runtime) throw new Error("Start This Computer before repairing its Account link.");
      const hostStatus = PersonalRemoteAccessStatusSchema.parse(await this.#host.status());
      const reconciliation = await this.#links.inspect(
        runtime.discovery.deploymentId,
        runtime,
        hostStatus.accountLink,
      );
      if (reconciliation.status !== "needs-repair") {
        throw new Error("This Personal Host's Account link does not need repair.");
      }
      await this.#links.clear(runtime.discovery.deploymentId);
      return this.#publish();
    });
  }

  rename(nameInput: string): Promise<DesktopPersonalAccountLinkStatus> {
    return this.#mutations.run("background", async () => {
      const name = nameInput.trim();
      if (!name || name.length > 120)
        throw new Error("Opensteer name must be 1 to 120 characters.");
      const runtime = await this.#runtime.current();
      const manifest = await this.#manifest.load();
      if (!runtime || !manifest) throw new Error("Start This Computer before renaming it.");
      const hostStatus = PersonalRemoteAccessStatusSchema.parse(await this.#host.status());
      const reconciliation = await this.#links.reconcileForMutation(
        runtime.discovery.deploymentId,
        runtime,
        hostStatus.accountLink,
      );
      if (reconciliation.status === "needs-repair") {
        throw new Error("This Personal Host's Account link needs repair before it can be renamed.");
      }
      if (hostStatus.accountLink) {
        const current = await this.#account.accountIdentity();
        if (
          !current ||
          current.issuer !== hostStatus.accountLink.issuer ||
          current.subject !== hostStatus.accountLink.subject
        ) {
          throw new Error("Sign in to the linked Account before renaming this Personal Host.");
        }
        const deployment = await this.#account.renamePersonalDeployment(
          runtime.discovery.deploymentId,
          name,
        );
        if (deployment.lifecycle !== "active") throw new Error("Account rename did not commit.");
        await this.#manifest.save(manifest, {
          ...manifest,
          name: deployment.name,
          revision: manifest.revision + 1,
          updatedAt: new Date().toISOString(),
        });
      } else {
        await this.#manifest.save(manifest, {
          ...manifest,
          name,
          revision: manifest.revision + 1,
          updatedAt: new Date().toISOString(),
        });
      }
      return this.#publish();
    });
  }

  async #runStep(step: PersonalAccountUnlinkStep, state: DesktopPersonalAccountLinkState) {
    switch (step) {
      case "disable-connect":
        await this.#remote.disableConnectForUnlink();
        return;
      case "revoke-account-sessions":
        await this.#host.revokeAccountSessionsForUnlink();
        return;
      case "revoke-connect-resource":
        await this.#remote.revokeConnectResourceForUnlink(
          state.unlinkOperation!.connectRevokeOperationId,
        );
        return;
      case "remove-host-link":
        await this.#host.removeAccountLinkForUnlink();
        return;
      case "repair-hosted-oauth-connections":
        await this.#host.repairHostedOAuthConnectionsForUnlink();
        return;
      case "retain-local-data":
        return;
    }
  }

  #publishUnlinkStep(
    deploymentId: DesktopPersonalAccountLinkStatus["deploymentId"],
    displayName: string | null,
    account: LinkAccount | null,
    state: DesktopPersonalAccountLinkState,
  ): void {
    const removed = state.unlinkOperation!.completedSteps.includes("remove-host-link");
    this.#notify(
      parseStatus({
        account: removed ? null : account,
        deploymentId,
        displayName,
        status: "unlinking",
        unlinkStep: nextUnlinkStep(state),
      }),
    );
  }

  async #publish(): Promise<DesktopPersonalAccountLinkStatus> {
    return this.#notify(await this.#readStatus());
  }

  #notify(status: DesktopPersonalAccountLinkStatus): DesktopPersonalAccountLinkStatus {
    for (const listener of this.#listeners) listener(status);
    return status;
  }
}

function nextUnlinkStep(state: DesktopPersonalAccountLinkState): PersonalAccountUnlinkStep | null {
  return unlinkSteps.find((step) => !state.unlinkOperation!.completedSteps.includes(step)) ?? null;
}

function parseStatus(
  input: Partial<DesktopPersonalAccountLinkStatus> &
    Pick<DesktopPersonalAccountLinkStatus, "status">,
): DesktopPersonalAccountLinkStatus {
  return DesktopPersonalAccountLinkStatusSchema.parse({
    account: null,
    deploymentId: null,
    displayName: null,
    unlinkStep: null,
    ...input,
  });
}
