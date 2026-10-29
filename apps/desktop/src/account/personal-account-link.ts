import {
  type CompletePersonalHostAccountLinkResponse,
  type IssuePersonalHostAccountLinkChallengeRequest,
  type IssuePersonalHostAccountLinkChallengeResponse,
  type PersonalHostAccountLinkChallengeId,
  type PersonalHostAccountLinkChallengeCredential,
  type PersonalHostAccountLinkProofEnvelope,
  PersonalHostAccountLinkOperationIdSchema,
} from "@opensteer/control-plane-protocol";
import { PersonalRemoteAccessStatusSchema } from "@opensteer/protocol";
import {
  AccountRequestError,
  type AccountDeploymentDirectoryService,
} from "@opensteer/client/connections";
import type {
  PersonalDeploymentFilesystemPort,
  PersonalDeploymentManifest,
} from "../secrets/personal-deployment-store.js";
import {
  emptyPersonalAccountLinkJournal,
  type DesktopPersonalAccountLinkState,
  type DesktopPersonalAccountLinkStore,
} from "./personal-account-link-store.js";
import {
  PersonalHostAccountLinkCompletionGrantRejectedError,
  type NativePersonalRemoteHostControl,
} from "../supervisor/personal-host-control.js";
import {
  DesktopPersonalAccountMutationCoordinator,
  PersonalAccountUnlinkInProgressError,
} from "./personal-account-mutation.js";
import {
  assertSamePersonalHostAuthority,
  PersonalHostRuntimeRecordSchema,
  type PersonalHostRuntimeRecord,
  type PersonalHostRuntimeSource,
} from "../supervisor/personal-host-runtime.js";

export interface PersonalAccountLinkControlPlane {
  readonly accountOrigin: string | null;
  accountIdentity(): Promise<{
    readonly issuer: string;
    readonly subject: string;
  } | null>;
  completePersonalHostAccountLink(
    challengeId: PersonalHostAccountLinkChallengeId,
    input: {
      readonly challengeCredential: PersonalHostAccountLinkChallengeCredential;
      readonly proof: PersonalHostAccountLinkProofEnvelope;
    },
  ): Promise<CompletePersonalHostAccountLinkResponse>;
  issuePersonalHostAccountLinkChallenge(
    input: IssuePersonalHostAccountLinkChallengeRequest,
  ): Promise<IssuePersonalHostAccountLinkChallengeResponse>;
}

type LinkStore = Pick<
  DesktopPersonalAccountLinkStore,
  "clear" | "inspect" | "reconcileForMutation" | "save"
>;
type LinkHost = Pick<
  NativePersonalRemoteHostControl,
  "approveAccountLink" | "consumeAccountLink" | "resumeAccountLink" | "status"
>;
type LinkManifest = Pick<PersonalDeploymentFilesystemPort, "load" | "save">;

/** Crash-safe courier for the Account challenge and the Host's local approval.
 * Secrets cross Desktop main memory only and every durable transition lands in
 * OS-protected storage before the next network side effect. */
export class DesktopPersonalAccountLinkCoordinator {
  readonly #account: PersonalAccountLinkControlPlane;
  readonly #host: LinkHost;
  readonly #manifest: LinkManifest;
  readonly #mutations: DesktopPersonalAccountMutationCoordinator;
  readonly #now: () => Date;
  readonly #runtime: PersonalHostRuntimeSource;
  readonly #store: LinkStore;

  constructor(options: {
    readonly account: Pick<
      AccountDeploymentDirectoryService,
      | "accountOrigin"
      | "accountIdentity"
      | "completePersonalHostAccountLink"
      | "issuePersonalHostAccountLinkChallenge"
    >;
    readonly host: LinkHost;
    readonly manifest: LinkManifest;
    readonly mutations?: DesktopPersonalAccountMutationCoordinator;
    readonly now?: () => Date;
    readonly runtime: PersonalHostRuntimeSource;
    readonly store: LinkStore;
  }) {
    this.#account = options.account;
    this.#host = options.host;
    this.#manifest = options.manifest;
    this.#mutations = options.mutations ?? new DesktopPersonalAccountMutationCoordinator();
    this.#now = options.now ?? (() => new Date());
    this.#runtime = options.runtime;
    this.#store = options.store;
  }

  async state(): Promise<DesktopPersonalAccountLinkState | null> {
    const runtime = await this.#runtime.current();
    if (!runtime) return null;
    return this.#inspect(PersonalHostRuntimeRecordSchema.parse(runtime));
  }

  ensureLinked(): Promise<DesktopPersonalAccountLinkState> {
    return this.#mutations.run("link", () => this.ensureLinkedForMutation());
  }

  /**
   * `retriedAfterExpiry` bounds the one re-entry this method is allowed. A
   * challenge that the Account reports expired is cleared and the transcript
   * restarted once; a second expiry within the same call means the clock or
   * the Account is refusing every challenge this Desktop can build, and
   * looping on it would be an unbounded retry loop wearing a recursion.
   */
  async ensureLinkedForMutation(
    retriedAfterExpiry = false,
  ): Promise<DesktopPersonalAccountLinkState> {
    const runtime = await this.#requireRuntime();
    const deploymentId = runtime.discovery.deploymentId;
    const manifest = await this.#requireManifest(runtime);
    const hostStatus = PersonalRemoteAccessStatusSchema.parse(await this.#host.status(runtime));
    const reconciliation = await this.#store.reconcileForMutation(
      deploymentId,
      runtime,
      hostStatus.accountLink,
    );
    if (reconciliation.status === "needs-repair") {
      throw new Error("This Personal Host's Account link needs repair before it can be changed.");
    }
    let state = reconciliation.journal ?? emptyPersonalAccountLinkJournal(runtime);

    if (state.unlinkOperation) throw new PersonalAccountUnlinkInProgressError();

    if (hostStatus.accountLink && !state.operation) {
      const currentAccount = await this.#account.accountIdentity();
      if (
        currentAccount &&
        (currentAccount.issuer !== hostStatus.accountLink.issuer ||
          currentAccount.subject !== hostStatus.accountLink.subject)
      ) {
        throw new Error("Unlink this Personal Host before linking it to another Account.");
      }
      if (hostStatus.accountLink.state === "activating") {
        // The Host resumes activation from its own row, so the journal that
        // carried this link there has nothing left to replay. Report the state
        // that survives the clear, not the one that was just discarded.
        await this.#host.resumeAccountLink(runtime);
        await this.#store.clear(deploymentId);
        return emptyPersonalAccountLinkJournal(runtime);
      }
      return state;
    }

    let operation = state.operation;
    if (
      operation &&
      !operation.completion &&
      Date.parse(operation.challenge.expiresAt) <= this.#now().getTime()
    ) {
      operation = null;
    }
    if (!operation) {
      const accountOrigin = this.#account.accountOrigin;
      if (!accountOrigin) {
        throw new Error("Opensteer Account linking is unavailable in this Desktop build.");
      }
      const operationId =
        state.issueOperationId ??
        PersonalHostAccountLinkOperationIdSchema.parse(`plo_${globalThis.crypto.randomUUID()}`);
      state = await this.#store.save(deploymentId, {
        ...state,
        issueOperationId: operationId,
        operation: null,
      });
      const challenge = await this.#account.issuePersonalHostAccountLinkChallenge({
        authorityEnvelope: runtime.discoveryEnvelope,
        name: manifest.name,
        operationId,
      });
      operation = { challenge, completion: null, operationId, proof: null };
      state = await this.#store.save(deploymentId, {
        ...state,
        issueOperationId: null,
        operation,
      });
    }

    let proof = operation.proof;
    if (!proof) {
      proof = await this.#host.approveAccountLink(runtime, operation.challenge);
      operation = { ...operation, proof };
      state = await this.#store.save(deploymentId, { ...state, operation });
    }

    let completion = operation.completion;
    let completionAlreadyConsumed = false;
    if (completion) {
      try {
        await this.#host.consumeAccountLink(runtime, {
          completionGrant: completion.completionGrant,
          hostCredential: completion.hostCredential,
          linkGeneration: completion.linkGeneration,
        });
        completionAlreadyConsumed = true;
      } catch (error) {
        if (!(error instanceof PersonalHostAccountLinkCompletionGrantRejectedError)) throw error;
        const currentAccount = await this.#account.accountIdentity();
        if (
          !currentAccount ||
          currentAccount.issuer !== operation.challenge.account.issuer ||
          currentAccount.subject !== operation.challenge.account.subject
        ) {
          throw new PersonalAccountLinkOriginalAccountRequiredError();
        }
        let refreshed;
        try {
          refreshed = await this.#account.completePersonalHostAccountLink(
            operation.challenge.challengeId,
            {
              challengeCredential: operation.challenge.challengeCredential,
              proof,
            },
          );
        } catch (completionError) {
          if (
            !retriedAfterExpiry &&
            (await this.#clearExpiredOperation(completionError, runtime, deploymentId))
          ) {
            return this.ensureLinkedForMutation(true);
          }
          throw completionError;
        }
        if (
          refreshed.hostCredential !== completion.hostCredential ||
          refreshed.linkGeneration !== completion.linkGeneration
        ) {
          throw new Error("Opensteer Account changed the Host link during recovery.");
        }
        completion = refreshed;
      }
    } else {
      try {
        completion = await this.#account.completePersonalHostAccountLink(
          operation.challenge.challengeId,
          {
            challengeCredential: operation.challenge.challengeCredential,
            proof,
          },
        );
      } catch (completionError) {
        if (
          !retriedAfterExpiry &&
          (await this.#clearExpiredOperation(completionError, runtime, deploymentId))
        ) {
          return this.ensureLinkedForMutation(true);
        }
        throw completionError;
      }
    }
    if (!completionAlreadyConsumed) {
      operation = { ...operation, completion };
      state = await this.#store.save(deploymentId, { ...state, operation });
      await this.#host.consumeAccountLink(runtime, {
        completionGrant: completion.completionGrant,
        hostCredential: completion.hostCredential,
        linkGeneration: completion.linkGeneration,
      });
    }
    await this.#store.clear(deploymentId);
    return emptyPersonalAccountLinkJournal(runtime);
  }

  async #clearExpiredOperation(
    error: unknown,
    runtime: PersonalHostRuntimeRecord,
    deploymentId: PersonalHostRuntimeRecord["discovery"]["deploymentId"],
  ): Promise<boolean> {
    if (
      !(error instanceof AccountRequestError) ||
      ![
        "personal-account-link-challenge-expired",
        "personal-account-link-reservation-expired",
      ].includes(error.reason ?? "")
    ) {
      return false;
    }
    const host = PersonalRemoteAccessStatusSchema.parse(await this.#host.status(runtime));
    if (host.accountLink) return false;
    await this.#store.clear(deploymentId);
    return true;
  }

  async #inspect(
    runtime: PersonalHostRuntimeRecord,
  ): Promise<DesktopPersonalAccountLinkState | null> {
    const status = PersonalRemoteAccessStatusSchema.parse(await this.#host.status(runtime));
    const reconciliation = await this.#store.inspect(
      runtime.discovery.deploymentId,
      runtime,
      status.accountLink,
    );
    if (reconciliation.status === "needs-repair") {
      throw new Error("This Personal Host's Account link needs repair.");
    }
    const state = reconciliation.journal;
    if (!state) return null;
    try {
      assertSamePersonalHostAuthority(state.authority, runtime);
    } catch (error) {
      throw new Error("The saved Account link belongs to an earlier Personal Host authority.", {
        cause: error,
      });
    }
    return state;
  }

  async #requireRuntime(): Promise<PersonalHostRuntimeRecord> {
    const runtime = await this.#runtime.current();
    if (!runtime) throw new Error("A ready Personal Host is required.");
    return PersonalHostRuntimeRecordSchema.parse(runtime);
  }

  async #requireManifest(runtime: PersonalHostRuntimeRecord): Promise<PersonalDeploymentManifest> {
    const manifest = await this.#manifest.load();
    if (!manifest || manifest.deploymentId !== runtime.discovery.deploymentId) {
      throw new Error("The Personal deployment manifest is unavailable.");
    }
    return manifest;
  }
}

export class PersonalAccountLinkOriginalAccountRequiredError extends Error {
  readonly code = "personal-account-link-original-account-required";

  constructor() {
    super("Sign in to the Account that started this Personal Host link to finish recovery.");
    this.name = "PersonalAccountLinkOriginalAccountRequiredError";
  }
}
