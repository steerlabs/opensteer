import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  CompletePersonalHostAccountLinkResponseSchema,
  ConnectOperationIdSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  PersonalHostAccountLinkOperationIdSchema,
} from "@opensteer/control-plane-protocol";
import {
  PersonalRemoteAccountLinkSchema,
  type PersonalRemoteAccountLink,
} from "@opensteer/protocol";
import { z } from "zod";
import {
  desktopPersonalAccountLinkSecretsPath,
  prepareDesktopDeploymentDirectories,
  preparePrivateDesktopDeploymentDirectories,
} from "../app/application-paths.js";
import {
  assertSamePersonalHostAuthority,
  PersonalHostRuntimeRecordSchema,
  type PersonalHostRuntimeRecord,
} from "../supervisor/personal-host-runtime.js";
import {
  ProtectedJsonFile,
  type DesktopSecretCryptography,
} from "../secrets/protected-json-file.js";
import type { DesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";

const maximumFileBytes = 256 * 1_024;
const maximumPlaintextBytes = 192 * 1_024;

const PendingLinkSchema = z
  .strictObject({
    challenge: IssuePersonalHostAccountLinkChallengeResponseSchema,
    completion: CompletePersonalHostAccountLinkResponseSchema.nullable(),
    operationId: PersonalHostAccountLinkOperationIdSchema,
    proof: PersonalHostAccountLinkProofEnvelopeSchema.nullable(),
  })
  .superRefine((operation, context) => {
    if (operation.completion && !operation.proof) {
      context.addIssue({
        code: "custom",
        message: "A completed Account link requires its Host-signed proof",
        path: ["completion"],
      });
    }
  });

export const PersonalAccountUnlinkStepSchema = z.enum([
  "disable-connect",
  "revoke-account-sessions",
  "revoke-connect-resource",
  "remove-host-link",
  "repair-hosted-oauth-connections",
  "retain-local-data",
]);
export type PersonalAccountUnlinkStep = z.infer<typeof PersonalAccountUnlinkStepSchema>;

const PersonalAccountUnlinkOperationSchema = z.strictObject({
  completedSteps: z.array(PersonalAccountUnlinkStepSchema).max(6),
  connectRevokeOperationId: ConnectOperationIdSchema,
  startedAt: z.iso.datetime({ offset: true }),
});

/** OS-protected crash-recovery journal. Completed link authority belongs only
 * to the Personal Host and is deliberately absent from this schema. */
export const DesktopPersonalAccountLinkStateSchema = z
  .strictObject({
    authority: PersonalHostRuntimeRecordSchema,
    issueOperationId: PersonalHostAccountLinkOperationIdSchema.nullable().default(null),
    operation: PendingLinkSchema.nullable(),
    schemaVersion: z.literal(4),
    unlinkOperation: PersonalAccountUnlinkOperationSchema.nullable(),
  })
  .superRefine((state, context) => {
    if (state.operation && state.unlinkOperation) {
      context.addIssue({
        code: "custom",
        message: "Link and unlink operations cannot be in progress together",
        path: ["unlinkOperation"],
      });
    }
    if (state.issueOperationId && (state.operation || state.unlinkOperation)) {
      context.addIssue({
        code: "custom",
        message: "Challenge issuance cannot overlap another link mutation",
        path: ["issueOperationId"],
      });
    }
    if (
      state.unlinkOperation &&
      new Set(state.unlinkOperation.completedSteps).size !==
        state.unlinkOperation.completedSteps.length
    ) {
      context.addIssue({
        code: "custom",
        message: "An unlink step can be completed only once",
        path: ["unlinkOperation", "completedSteps"],
      });
    }
  });
export type DesktopPersonalAccountLinkState = z.infer<typeof DesktopPersonalAccountLinkStateSchema>;

export type DesktopPersonalAccountLinkReconciliation =
  | { readonly journal: DesktopPersonalAccountLinkState | null; readonly status: "ready" }
  | {
      readonly journal: DesktopPersonalAccountLinkState | null;
      readonly status: "needs-repair";
    };

/** Critical operation journal. Incompatible state is never silently discarded. */
export class DesktopPersonalAccountLinkStore {
  readonly #cryptography: DesktopSecretCryptography;
  readonly #dataDirectory: string;
  readonly #files = new Map<DeploymentId, ProtectedJsonFile<DesktopPersonalAccountLinkState>>();
  readonly #platform: NodeJS.Platform | undefined;
  readonly #privateFiles: DesktopPrivateFilesystem | undefined;
  readonly #tails = new Map<DeploymentId, Promise<void>>();

  constructor(options: {
    readonly cryptography: DesktopSecretCryptography;
    readonly dataDirectory: string;
    readonly platform?: NodeJS.Platform;
    readonly privateFiles?: DesktopPrivateFilesystem;
  }) {
    this.#cryptography = options.cryptography;
    this.#dataDirectory = options.dataDirectory;
    this.#platform = options.platform;
    this.#privateFiles = options.privateFiles;
  }

  load(deploymentId: DeploymentId | string): Promise<DesktopPersonalAccountLinkState | null> {
    const id = DeploymentIdSchema.parse(deploymentId);
    return this.#serialize(id, async () => {
      const state = await this.#file(id).read();
      if (state && state.authority.discovery.deploymentId !== id) {
        throw new Error("The protected Personal Account link belongs to another Deployment.");
      }
      return state;
    });
  }

  save(
    deploymentId: DeploymentId | string,
    input: DesktopPersonalAccountLinkState,
  ): Promise<DesktopPersonalAccountLinkState> {
    const id = DeploymentIdSchema.parse(deploymentId);
    const state = DesktopPersonalAccountLinkStateSchema.parse(input);
    if (state.authority.discovery.deploymentId !== id) {
      throw new Error("A Personal Account link cannot be stored under another Deployment.");
    }
    return this.#serialize(id, async () => {
      if (this.#privateFiles) {
        await preparePrivateDesktopDeploymentDirectories(
          this.#privateFiles,
          this.#dataDirectory,
          id,
        );
      } else {
        prepareDesktopDeploymentDirectories(this.#dataDirectory, id);
      }
      await this.#file(id).write(state);
      return state;
    });
  }

  clear(deploymentId: DeploymentId | string): Promise<void> {
    const id = DeploymentIdSchema.parse(deploymentId);
    return this.#serialize(id, () => this.#file(id).remove());
  }

  /**
   * Read-only reconciliation. Reading status must never rewrite the journal:
   * the same answer is projected on every poll, so a write here would make an
   * observation a durable side effect.
   *
   * Every way this journal can be unusable — a corrupt or undecryptable file,
   * a schema this build does not know, an authority that is not this Host's,
   * or a structurally impossible operation record — resolves to needs-repair
   * rather than a throw, because needs-repair is the state the owner has an
   * exit from. The evidence is left on disk untouched.
   */
  inspect(
    deploymentId: DeploymentId | string,
    authority: PersonalHostRuntimeRecord,
    accountLink: PersonalRemoteAccountLink | null,
  ): Promise<DesktopPersonalAccountLinkReconciliation> {
    const { id, link, runtime } = this.#reconciliationInput(deploymentId, authority, accountLink);
    return this.#serialize(id, async () => {
      let derived;
      try {
        derived = await this.#derive(id, runtime, link);
      } catch {
        return { journal: null, status: "needs-repair" };
      }
      if (!derived) return { journal: null, status: "needs-repair" };
      return {
        journal: journalIsEmpty(derived.journal) ? null : derived.journal,
        status: "ready",
      };
    });
  }

  /**
   * Reconciliation for a mutation that is about to act on the journal. It may
   * commit an inferred boundary or delete a spent journal, and it fails closed
   * on an unreadable file: a mutation must not proceed on state it cannot see.
   */
  reconcileForMutation(
    deploymentId: DeploymentId | string,
    authority: PersonalHostRuntimeRecord,
    accountLink: PersonalRemoteAccountLink | null,
  ): Promise<DesktopPersonalAccountLinkReconciliation> {
    const { id, link, runtime } = this.#reconciliationInput(deploymentId, authority, accountLink);
    return this.#serialize(id, async () => {
      const derived = await this.#derive(id, runtime, link);
      if (!derived) return { journal: null, status: "needs-repair" };
      if (journalIsEmpty(derived.journal)) {
        // Only a journal that exists is worth deleting; a Deployment that never
        // wrote one must not pay a protected-storage round trip to learn that.
        if (derived.stored) await this.#file(id).remove();
        return { journal: null, status: "ready" };
      }
      if (derived.changed) await this.#file(id).write(derived.journal);
      return { journal: derived.journal, status: "ready" };
    });
  }

  #reconciliationInput(
    deploymentId: DeploymentId | string,
    authority: PersonalHostRuntimeRecord,
    accountLink: PersonalRemoteAccountLink | null,
  ) {
    const id = DeploymentIdSchema.parse(deploymentId);
    const runtime = PersonalHostRuntimeRecordSchema.parse(authority);
    const link = PersonalRemoteAccountLinkSchema.nullable().parse(accountLink);
    if (runtime.discovery.deploymentId !== id) {
      throw new Error("A Personal Account journal cannot be reconciled with another Deployment.");
    }
    return { id, link, runtime };
  }

  /** Null means the stored journal is unusable and needs repair. */
  async #derive(
    id: DeploymentId,
    runtime: PersonalHostRuntimeRecord,
    link: PersonalRemoteAccountLink | null,
  ): Promise<{
    readonly changed: boolean;
    readonly journal: DesktopPersonalAccountLinkState;
    readonly stored: boolean;
  } | null> {
    const stored = await this.#file(id).read();
    if (stored && stored.authority.discovery.deploymentId !== id) {
      throw new Error("The protected Personal Account journal belongs to another Deployment.");
    }
    if (!stored) {
      return { changed: false, journal: emptyPersonalAccountLinkJournal(runtime), stored: false };
    }
    assertSamePersonalHostAuthority(stored.authority, runtime);
    const reconciled = reconcileCurrentState(stored, link);
    if (!reconciled) return null;
    return { changed: reconciled !== stored, journal: reconciled, stored: true };
  }

  #file(deploymentId: DeploymentId): ProtectedJsonFile<DesktopPersonalAccountLinkState> {
    let file = this.#files.get(deploymentId);
    if (!file) {
      file = new ProtectedJsonFile({
        content: "critical",
        cryptography: this.#cryptography,
        filePath: desktopPersonalAccountLinkSecretsPath(this.#dataDirectory, deploymentId),
        maxFileBytes: maximumFileBytes,
        maxPlaintextBytes: maximumPlaintextBytes,
        messages: {
          protectedState: "The Desktop Personal Account link",
          protectedStore: "The protected Desktop Personal Account link store",
        },
        ...(this.#platform === undefined ? {} : { platform: this.#platform }),
        ...(this.#privateFiles === undefined ? {} : { privateFiles: this.#privateFiles }),
        schema: DesktopPersonalAccountLinkStateSchema,
      });
      this.#files.set(deploymentId, file);
    }
    return file;
  }

  #serialize<T>(deploymentId: DeploymentId, operation: () => Promise<T>): Promise<T> {
    const tail = this.#tails.get(deploymentId) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    const next = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(deploymentId, next);
    void next.finally(() => {
      if (this.#tails.get(deploymentId) === next) this.#tails.delete(deploymentId);
    });
    return result;
  }
}

function reconcileCurrentState(
  state: DesktopPersonalAccountLinkState,
  hostLink: PersonalRemoteAccountLink | null,
): DesktopPersonalAccountLinkState | null {
  if (state.unlinkOperation) {
    if (!isCurrentUnlinkPrefix(state.unlinkOperation.completedSteps)) return null;
    const hostRemovalRecorded = state.unlinkOperation.completedSteps.includes("remove-host-link");
    if (hostLink && hostRemovalRecorded) return null;
    if (hostLink || hostRemovalRecorded) return state;
    if (
      !(["disable-connect", "revoke-account-sessions", "revoke-connect-resource"] as const).every(
        (step) => state.unlinkOperation!.completedSteps.includes(step),
      )
    ) {
      return null;
    }
    return DesktopPersonalAccountLinkStateSchema.parse({
      ...state,
      unlinkOperation: {
        ...state.unlinkOperation,
        completedSteps: [...state.unlinkOperation.completedSteps, "remove-host-link"],
      },
    });
  }
  if (!state.operation || !hostLink) return state;
  const completion = state.operation.completion;
  if (
    !completion ||
    completion.linkGeneration !== hostLink.generation ||
    state.operation.challenge.account.issuer !== hostLink.issuer ||
    state.operation.challenge.account.subject !== hostLink.subject
  ) {
    return null;
  }
  return state;
}

export function emptyPersonalAccountLinkJournal(
  authority: PersonalHostRuntimeRecord,
): DesktopPersonalAccountLinkState {
  return DesktopPersonalAccountLinkStateSchema.parse({
    authority,
    issueOperationId: null,
    operation: null,
    schemaVersion: 4,
    unlinkOperation: null,
  });
}

function journalIsEmpty(state: DesktopPersonalAccountLinkState): boolean {
  return (
    state.issueOperationId === null && state.operation === null && state.unlinkOperation === null
  );
}

const currentUnlinkOrder = [
  "disable-connect",
  "revoke-account-sessions",
  "revoke-connect-resource",
  "remove-host-link",
  "repair-hosted-oauth-connections",
  "retain-local-data",
] as const;

function isCurrentUnlinkPrefix(completed: readonly PersonalAccountUnlinkStep[]): boolean {
  return completed.every((step, index) => currentUnlinkOrder[index] === step);
}
