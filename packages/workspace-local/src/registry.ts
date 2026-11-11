import { readBounded } from "@opensteer/shared/privateFiles";
import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { syncDirectory } from "@opensteer/shared/privateFiles";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import {
  EnvironmentIdSchema,
  StorageAuthorityIdSchema,
  UserIdSchema,
  WorkspaceBindingIdSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
  createId,
  type EnvironmentId,
  type StorageAuthorityId,
  type WorkspaceBindingId,
  type WorkspaceId,
} from "@opensteer/core";
import { workspacePathSegments } from "@opensteer/workspace";
import { constants, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LocalWorkspaceError, LocalWorkspaceErrorCode } from "./errors.js";
import {
  NativeDirectoryIdentitySchema,
  type NativeDirectoryIdentity,
  type NativeFilesystem,
} from "./native-fs-helper.js";

const REGISTRY_VERSION = 3;
/** Destruction tombstones are how a lost response is answered truthfully, so
 * they outlive the binding. The bound keeps the protected file finite; the
 * oldest receipts are dropped first, and a replay whose receipt has aged out
 * re-runs an idempotent destroy rather than inventing an answer. */
const MAX_DESTRUCTION_RECEIPTS = 10_000;
const MAX_REGISTRY_BYTES = 16 * 1_024 * 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const RelativeSegmentSchema = z.string().regex(SAFE_SEGMENT);

const FilesystemIdentitySchema = NativeDirectoryIdentitySchema;
export type FilesystemIdentity = NativeDirectoryIdentity;

const ProvisionFingerprintSchema = z.strictObject({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,127}$/)
    .optional(),
  createdBy: UserIdSchema.optional(),
  kind: z.preprocess((value) => (value === "specialized" ? "project" : value), WorkspaceKindSchema),
  ownerEnvironmentId: EnvironmentIdSchema,
  workspaceId: WorkspaceIdSchema,
});
export type ProvisionFingerprint = z.infer<typeof ProvisionFingerprintSchema>;

const RegistryBindingBaseSchema = z.strictObject({
  relocation: z
    .strictObject({
      source: z.array(RelativeSegmentSchema).min(1).max(4),
      target: z.array(RelativeSegmentSchema).min(1).max(4),
      state: z.enum(["planned", "renamed", "bound", "blocked"]),
    })
    .optional(),
  bindingId: WorkspaceBindingIdSchema,
  createdBy: UserIdSchema.optional(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: z.string().min(1).max(512),
  ownerEnvironmentId: EnvironmentIdSchema,
  provisionFingerprint: ProvisionFingerprintSchema,
  relativeSegments: z.array(RelativeSegmentSchema).min(1).max(4),
  workspaceId: WorkspaceIdSchema,
});

const PendingRegistryBindingSchema = RegistryBindingBaseSchema.extend({
  state: z.literal("provisioning"),
});

const ReadyRegistryBindingSchema = RegistryBindingBaseSchema.extend({
  filesystemIdentity: FilesystemIdentitySchema,
  state: z.literal("ready"),
});

const RegistryBindingSchema = z.discriminatedUnion("state", [
  PendingRegistryBindingSchema,
  ReadyRegistryBindingSchema,
]);
export type RegistryBinding = z.infer<typeof RegistryBindingSchema>;
export type ReadyRegistryBinding = z.infer<typeof ReadyRegistryBindingSchema>;

const LocalWorkspaceNamespaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("single-owner"),
    ownerEnvironmentId: EnvironmentIdSchema,
  }),
  z.strictObject({ kind: z.literal("owner-scoped") }),
  z.strictObject({ kind: z.literal("team-project"), ownerEnvironmentId: EnvironmentIdSchema }),
]);

const DestructionReceiptSchema = z.strictObject({
  bindingId: WorkspaceBindingIdSchema,
  destroyedAt: z.iso.datetime({ offset: true }),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outcome: z.enum(["destroyed", "already-destroyed"]),
  workspaceId: WorkspaceIdSchema,
});
export type DestructionReceipt = z.infer<typeof DestructionReceiptSchema>;

/** What one disk holds, as the owning Runner reports it on connect. */
export interface LocalStorageInventory {
  bindings: {
    bindingId: WorkspaceBindingId;
    generation: number;
    path: string;
    state: RegistryBinding["state"];
    workspaceId: WorkspaceId;
  }[];
  storageAuthorityId: StorageAuthorityId;
  truncated: boolean;
}

const RegistryDocumentSchema = z.strictObject({
  bindings: z.array(RegistryBindingSchema).max(100_000),
  namespace: LocalWorkspaceNamespaceSchema,
  receipts: z.array(DestructionReceiptSchema).max(MAX_DESTRUCTION_RECEIPTS),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rootIdentity: FilesystemIdentitySchema,
  /**
   * Minted once, when this protected registry is first written, and never
   * rewritten. It is the disk's identity: a Runner credential copied to another
   * computer gets a different one, so it cannot answer for, or destroy, the
   * Workspaces that live here.
   */
  storageAuthorityId: StorageAuthorityIdSchema,
  version: z.literal(REGISTRY_VERSION),
});
const LegacyRegistryDocumentSchema = RegistryDocumentSchema.omit({
  receipts: true,
  storageAuthorityId: true,
  version: true,
}).extend({ version: z.literal(2) });
export type RegistryDocument = z.infer<typeof RegistryDocumentSchema>;

export type LocalWorkspaceNamespace =
  | {
      readonly kind: "single-owner";
      readonly ownerEnvironmentId: EnvironmentId;
    }
  | { readonly kind: "owner-scoped" }
  | { readonly kind: "team-project"; readonly ownerEnvironmentId: EnvironmentId };

export interface LocalWorkspaceRegistryOptions {
  readonly filesystemAuthority?: Pick<
    NativeFilesystem,
    "directoryIdentity" | "ensureDirectory" | "ensureRoot" | "list" | "relocateDirectory"
  >;
  readonly legacyRegistryFilePath?: string;
  readonly namespace: LocalWorkspaceNamespace;
  readonly registryFilePath: string;
  readonly visibleRootPath: string;
}

interface NormalizedRegistryOptions extends LocalWorkspaceRegistryOptions {
  readonly registryFilePath: string;
  readonly visibleRootPath: string;
}

const registryWriteTails = new Map<string, Promise<void>>();

export class LocalWorkspaceRegistry {
  readonly #options: NormalizedRegistryOptions;

  constructor(options: LocalWorkspaceRegistryOptions) {
    if (process.platform === "win32" && options.filesystemAuthority === undefined) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.configurationInvalid,
        message: "Windows local Workspaces require the native filesystem authority.",
      });
    }
    this.#options = normalizeOptions(options);
  }

  get namespace(): LocalWorkspaceNamespace {
    return this.#options.namespace;
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    await withRegistryWriteLock(this.#options.registryFilePath, async () => {
      signal?.throwIfAborted();
      await this.#migrateLegacyRegistry(signal);
      if ((await lstatOrUndefined(this.#options.registryFilePath)) !== undefined) {
        const document = await this.#readRegistry();
        await this.#assertRootIdentity(document);
        signal?.throwIfAborted();
        return;
      }

      await this.#ensureVisibleRoot();
      signal?.throwIfAborted();
      if (!(await this.#visibleRootIsEmpty(signal))) {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.registryInvalid,
          message:
            "The protected local Workspace registry is missing for a non-empty managed root.",
        });
      }
      const document: RegistryDocument = {
        bindings: [],
        namespace: this.#options.namespace,
        receipts: [],
        revision: 0,
        rootIdentity: await this.#readDirectoryIdentity([]),
        storageAuthorityId: createId("storageAuthority"),
        version: REGISTRY_VERSION,
      };
      await writeRegistryAtomic(this.#options.registryFilePath, document);
      signal?.throwIfAborted();
    });
  }

  async #migrateLegacyRegistry(signal?: AbortSignal): Promise<void> {
    const legacyPath = this.#options.legacyRegistryFilePath;
    if (
      legacyPath === undefined ||
      (await lstatOrUndefined(this.#options.registryFilePath)) !== undefined ||
      (await lstatOrUndefined(legacyPath)) === undefined
    ) {
      return;
    }
    signal?.throwIfAborted();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(await readProtectedFile(legacyPath));
    } catch (cause) {
      throw new LocalWorkspaceError({
        cause,
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The legacy protected local Workspace registry is invalid.",
      });
    }
    const parsed = LegacyRegistryDocumentSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new LocalWorkspaceError({
        cause: parsed.error,
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The legacy protected local Workspace registry has an invalid shape.",
      });
    }
    assertRegistryUniqueness(parsed.data);
    if (!sameNamespace(parsed.data.namespace, this.#options.namespace)) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.configurationInvalid,
        message: "The configured local Workspace namespace does not match its legacy registry.",
      });
    }
    await this.#assertRootIdentity(parsed.data);
    signal?.throwIfAborted();
    await writeRegistryAtomic(this.#options.registryFilePath, {
      ...parsed.data,
      receipts: [],
      storageAuthorityId: createId("storageAuthority"),
      version: REGISTRY_VERSION,
    });
  }

  async provision(input: {
    readonly bindingId: WorkspaceBindingId;
    readonly fingerprint: ProvisionFingerprint;
    readonly generation: number;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ReadyRegistryBinding> {
    return withRegistryWriteLock(this.#options.registryFilePath, async () => {
      input.signal?.throwIfAborted();
      let document = await this.#readOrCreateRegistry(input.signal);
      const byIdempotencyKey = document.bindings.find(
        (binding) => binding.idempotencyKey === input.idempotencyKey,
      );
      if (byIdempotencyKey !== undefined) {
        assertSameProvision(byIdempotencyKey, input);
        return this.#finishProvision(document, byIdempotencyKey, true, input.signal);
      }

      if (document.namespace.kind === "team-project") {
        if (
          input.fingerprint.kind !== "project" ||
          input.fingerprint.createdBy ||
          input.fingerprint.slug
        )
          throw new Error("Team storage refuses person-owned provisioning");
      } else if (!input.fingerprint.createdBy) {
        throw new Error("Legacy storage requires a person-owned provisioning intent");
      }
      assertProvisionDoesNotConflict(document, input);
      assertOwnerAllowed(this.#options.namespace, input.fingerprint.ownerEnvironmentId);
      const relativeSegments = [
        ...workspacePathSegments(
          {
            createdBy: input.fingerprint.createdBy,
            id: input.fingerprint.workspaceId,
            kind: input.fingerprint.kind,
            ...(input.fingerprint.slug ? { slug: input.fingerprint.slug } : {}),
          },
          this.#options.namespace.kind,
        ),
      ];
      if (input.fingerprint.kind === "project" && input.fingerprint.slug) {
        const main = document.bindings.find(
          (binding) =>
            binding.provisionFingerprint.kind === "main" &&
            binding.createdBy === input.fingerprint.createdBy &&
            binding.ownerEnvironmentId === input.fingerprint.ownerEnvironmentId &&
            binding.state === "ready",
        );
        if (!main || main.state !== "ready") {
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "A Project requires its owner's ready Main on this storage authority.",
          });
        }
        await this.#assertWorkspaceIdentity(main);
      }
      const pathCollision = document.bindings.find((binding) =>
        equalSegments(
          binding.relativeSegments.map((segment) => segment.toLowerCase()),
          relativeSegments.map((segment) => segment.toLowerCase()),
        ),
      );
      if (pathCollision !== undefined) {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "The managed Workspace directory is already bound to another Workspace.",
        });
      }

      if (!this.#options.filesystemAuthority) {
        await ensureManagedParentDirectories(
          this.#options.visibleRootPath,
          relativeSegments.slice(0, -1),
        );
      }
      const targetPath = resolveContainedPath(this.#options.visibleRootPath, relativeSegments);
      if (
        !this.#options.filesystemAuthority &&
        (await lstatOrUndefined(targetPath)) !== undefined
      ) {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "The managed Workspace directory already exists without a binding.",
        });
      }

      const pending: RegistryBinding = {
        bindingId: input.bindingId,
        createdBy: input.fingerprint.createdBy,
        generation: input.generation,
        idempotencyKey: input.idempotencyKey,
        ownerEnvironmentId: input.fingerprint.ownerEnvironmentId,
        provisionFingerprint: input.fingerprint,
        relativeSegments,
        state: "provisioning",
        workspaceId: input.fingerprint.workspaceId,
      };
      document = nextDocument(document, [...document.bindings, pending]);
      await writeRegistryAtomic(this.#options.registryFilePath, document);
      return this.#finishProvision(document, pending, false, input.signal);
    });
  }

  async relocate(input: {
    readonly bindingId: WorkspaceBindingId;
    readonly workspaceId: WorkspaceId;
    readonly generation: number;
    readonly slug: string | null;
    readonly adopt?: boolean;
    readonly createdBy?: ProvisionFingerprint["createdBy"];
    readonly ownerEnvironmentId?: EnvironmentId;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await withRegistryWriteLock(this.#options.registryFilePath, async () => {
      let document = await this.#readOrCreateRegistry(input.signal);
      let binding = document.bindings.find((candidate) => candidate.bindingId === input.bindingId);
      if (input.slug === null) {
        if (!input.adopt || !input.createdBy || !input.ownerEnvironmentId)
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "Main adoption requires explicit confirmation and its owner.",
          });
        assertOwnerAllowed(this.#options.namespace, input.ownerEnvironmentId);
        if (binding) {
          if (
            binding.state !== "ready" ||
            binding.workspaceId !== input.workspaceId ||
            binding.generation !== input.generation ||
            binding.createdBy !== input.createdBy ||
            binding.ownerEnvironmentId !== input.ownerEnvironmentId ||
            binding.provisionFingerprint.kind !== "main"
          )
            throw new LocalWorkspaceError({
              code: LocalWorkspaceErrorCode.workspaceMismatch,
              message: "Main binding does not match adoption.",
            });
          await this.#assertWorkspaceIdentity(binding);
          return;
        }
        const fingerprint: ProvisionFingerprint = {
          kind: "main",
          createdBy: input.createdBy,
          ownerEnvironmentId: input.ownerEnvironmentId,
          workspaceId: input.workspaceId,
        };
        const target = [
          ...workspacePathSegments(
            { createdBy: input.createdBy, id: input.workspaceId, kind: "main" },
            this.#options.namespace.kind,
          ),
        ];
        if (
          document.bindings.some(
            (candidate) =>
              candidate.workspaceId === input.workspaceId ||
              (candidate.createdBy === input.createdBy &&
                candidate.provisionFingerprint.kind === "main") ||
              equalSegments(
                candidate.relativeSegments.map((segment) => segment.toLowerCase()),
                target.map((segment) => segment.toLowerCase()),
              ),
          )
        )
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "Main is already bound.",
          });
        const filesystemIdentity = await this.#readDirectoryIdentity(target);
        const adopted: ReadyRegistryBinding = {
          bindingId: input.bindingId,
          generation: input.generation,
          createdBy: input.createdBy,
          ownerEnvironmentId: input.ownerEnvironmentId,
          workspaceId: input.workspaceId,
          idempotencyKey: `workspace:${input.workspaceId}:adopt:v1`,
          state: "ready",
          filesystemIdentity,
          relativeSegments: target,
          provisionFingerprint: fingerprint,
        };
        await writeRegistryAtomic(
          this.#options.registryFilePath,
          nextDocument(document, [...document.bindings, adopted]),
        );
        return;
      }
      if (!binding && input.adopt && input.createdBy && input.ownerEnvironmentId) {
        const main = document.bindings.find(
          (candidate) =>
            candidate.state === "ready" &&
            candidate.createdBy === input.createdBy &&
            candidate.provisionFingerprint.kind === "main",
        );
        if (!main || main.state !== "ready")
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "Main must be ready before adoption.",
          });
        if (
          main.ownerEnvironmentId !== input.ownerEnvironmentId ||
          document.bindings.some((candidate) => candidate.workspaceId === input.workspaceId)
        )
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "This Project already has a binding or Main belongs to another environment.",
          });
        const target = [
          ...main.relativeSegments,
          "Projects",
          RelativeSegmentSchema.parse(input.slug),
        ];
        await this.#assertWorkspaceIdentity(main);
        if (
          document.bindings.some((candidate) =>
            equalSegments(
              candidate.relativeSegments.map((s) => s.toLowerCase()),
              target.map((s) => s.toLowerCase()),
            ),
          )
        )
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "Target is already bound.",
          });
        const filesystemIdentity = await this.#readDirectoryIdentity(target);
        const adopted: ReadyRegistryBinding = {
          bindingId: input.bindingId,
          generation: input.generation,
          createdBy: input.createdBy,
          ownerEnvironmentId: input.ownerEnvironmentId,
          workspaceId: input.workspaceId,
          idempotencyKey: `workspace:${input.workspaceId}:adopt:v1`,
          state: "ready",
          filesystemIdentity,
          relativeSegments: target,
          provisionFingerprint: {
            createdBy: input.createdBy,
            ownerEnvironmentId: input.ownerEnvironmentId,
            workspaceId: input.workspaceId,
            kind: "project",
            slug: input.slug,
          },
        };
        await writeRegistryAtomic(
          this.#options.registryFilePath,
          nextDocument(document, [...document.bindings, adopted]),
        );
        return;
      }
      if (
        !binding ||
        binding.state !== "ready" ||
        binding.workspaceId !== input.workspaceId ||
        binding.generation !== input.generation ||
        binding.provisionFingerprint.kind !== "project"
      ) {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceMismatch,
          message: "Project binding does not match relocation.",
        });
      }
      const main = document.bindings.find(
        (candidate) =>
          candidate.state === "ready" &&
          candidate.provisionFingerprint.kind === "main" &&
          candidate.createdBy === binding!.createdBy &&
          candidate.ownerEnvironmentId === binding!.ownerEnvironmentId,
      );
      if (!main || main.state !== "ready")
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "The owner's Main is not ready on this storage authority.",
        });
      await this.#assertWorkspaceIdentity(main);
      const target = [
        ...main.relativeSegments,
        "Projects",
        RelativeSegmentSchema.parse(input.slug),
      ];
      if (
        equalSegments(binding.relativeSegments, target) &&
        (!binding.relocation || binding.relocation.state === "bound")
      ) {
        await this.#assertWorkspaceIdentity(binding);
        return;
      }
      if (
        document.bindings.some(
          (candidate) =>
            candidate.bindingId !== binding!.bindingId &&
            equalSegments(
              candidate.relativeSegments.map((s) => s.toLowerCase()),
              target.map((s) => s.toLowerCase()),
            ),
        )
      )
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "The relocation destination is already bound.",
        });
      const save = async (updated: ReadyRegistryBinding) => {
        document = nextDocument(
          document,
          document.bindings.map((candidate) =>
            candidate.bindingId === updated.bindingId ? updated : candidate,
          ),
        );
        await writeRegistryAtomic(this.#options.registryFilePath, document);
        binding = updated;
      };
      // Persist the source identity before rename. A missing source is resumable
      // only when the destination is still that exact directory.
      if (!binding.relocation)
        await save({
          ...binding,
          relocation: { source: binding.relativeSegments, target, state: "planned" },
        });
      const relocation = binding.relocation!;
      if (!equalSegments(relocation.target, target))
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "The recorded relocation destination differs.",
        });
      if (input.adopt) {
        const identity = await this.#readDirectoryIdentity(target);
        await save({
          ...binding,
          filesystemIdentity: identity,
          provisionFingerprint: { ...binding.provisionFingerprint, slug: input.slug },
          relativeSegments: target,
          relocation: { ...relocation, state: "bound" },
        });
        return;
      }
      if (relocation.state === "blocked")
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "Move the Project folder into Main and explicitly confirm its new location.",
        });
      if (relocation.state === "planned") {
        const sourcePath = resolveContainedPath(this.#options.visibleRootPath, relocation.source);
        const targetPath = resolveContainedPath(this.#options.visibleRootPath, target);
        const sourceExists = await lstatOrUndefined(sourcePath);
        if (sourceExists) {
          await this.#assertWorkspaceIdentity(binding);
          if (await lstatOrUndefined(targetPath)) {
            await save({ ...binding, relocation: { ...relocation, state: "blocked" } });
            throw new LocalWorkspaceError({
              code: LocalWorkspaceErrorCode.workspaceConflict,
              message: `Relocation destination is occupied: ${targetPath}`,
            });
          }
          const move = this.#options.filesystemAuthority?.relocateDirectory;
          if (!move) {
            await save({ ...binding, relocation: { ...relocation, state: "blocked" } });
            throw new LocalWorkspaceError({
              code: LocalWorkspaceErrorCode.configurationInvalid,
              message: "Automatic Project relocation requires the native filesystem helper.",
            });
          }
          try {
            await move.call(
              this.#options.filesystemAuthority,
              {
                root: this.#options.visibleRootPath,
                path: relocation.source.join("/"),
                destination: target.join("/"),
              },
              input.signal ?? AbortSignal.timeout(30_000),
            );
          } catch (error) {
            if (
              ["configuration-invalid", "already-exists", "cross-device"].includes(
                nativeErrorCode(error) ?? "",
              )
            ) {
              await save({ ...binding, relocation: { ...relocation, state: "blocked" } });
              throw new LocalWorkspaceError({
                code: LocalWorkspaceErrorCode.configurationInvalid,
                message:
                  "Automatic relocation is unavailable or its destination is occupied. Move the folder manually and confirm its location.",
                cause: error,
              });
            }
            throw error;
          }
        }
        const identity = await this.#readDirectoryIdentity(target);
        if (!equalIdentity(identity, binding.filesystemIdentity))
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.directoryReplaced,
            message: "Relocation target is not the original Project directory.",
          });
        await save({ ...binding, relocation: { ...relocation, state: "renamed" } });
      }
      const identity = await this.#readDirectoryIdentity(target);
      if (!equalIdentity(identity, binding.filesystemIdentity))
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.directoryReplaced,
          message: "Relocated Project identity changed.",
        });
      await save({
        ...binding,
        provisionFingerprint: { ...binding.provisionFingerprint, slug: input.slug },
        relativeSegments: target,
        relocation: { ...relocation, state: "bound" },
      });
    });
  }

  /** The durable identity of the disk this registry protects. */
  async storageAuthority(signal?: AbortSignal): Promise<StorageAuthorityId> {
    return withRegistryWriteLock(this.#options.registryFilePath, async () => {
      const document = await this.#readRegistryOrCreate(signal);
      return document.storageAuthorityId;
    });
  }

  /** What this disk currently holds, for reconnect reconciliation. */
  async inventory(signal?: AbortSignal): Promise<LocalStorageInventory> {
    return withRegistryWriteLock(this.#options.registryFilePath, async () => {
      const document = await this.#readRegistryOrCreate(signal);
      const bindings = document.bindings.slice(0, MAX_DESTRUCTION_RECEIPTS).map((binding) => ({
        bindingId: binding.bindingId,
        generation: binding.generation,
        path: resolveContainedPath(this.#options.visibleRootPath, binding.relativeSegments),
        state: binding.state,
        workspaceId: binding.workspaceId,
      }));
      return {
        bindings,
        storageAuthorityId: document.storageAuthorityId,
        truncated: document.bindings.length > bindings.length,
      };
    });
  }

  async destroy(input: {
    readonly bindingId: WorkspaceBindingId;
    readonly generation: number;
    readonly signal?: AbortSignal;
    readonly workspaceId: WorkspaceId;
  }): Promise<DestructionReceipt> {
    return withRegistryWriteLock(this.#options.registryFilePath, async () => {
      input.signal?.throwIfAborted();
      const document = await this.#readRegistry();
      const binding = document.bindings.find(
        (candidate) => candidate.bindingId === input.bindingId,
      );
      if (!binding) {
        // An absent binding is not evidence of destruction; only a recorded
        // tombstone is. Without one this request has to be refused so the Host
        // keeps the Workspace in `deleting` rather than declaring it erased.
        const recorded = document.receipts.find(
          (receipt) =>
            receipt.bindingId === input.bindingId &&
            receipt.generation === input.generation &&
            receipt.workspaceId === input.workspaceId,
        );
        if (recorded) return recorded;
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.registryInvalid,
          message: "This machine has no record of destroying that local Workspace directory.",
        });
      }
      if (binding.relocation && binding.relocation.state !== "bound")
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "Finish Project relocation before deleting its files.",
        });
      if (binding.provisionFingerprint.kind === "main") {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceConflict,
          message: "Main cannot be destroyed",
        });
      }
      if (binding.workspaceId !== input.workspaceId) {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.workspaceMismatch,
          message: "The local Workspace binding belongs to another Workspace.",
        });
      }
      if (binding.generation !== input.generation) {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.generationMismatch,
          message: "The local Workspace binding generation is stale.",
        });
      }

      try {
        await this.#assertRootIdentity(document);
      } catch (error) {
        if (
          !(error instanceof LocalWorkspaceError) ||
          error.code !== LocalWorkspaceErrorCode.directoryMissing
        ) {
          throw error;
        }
        return this.#commitDestruction(document, binding, "already-destroyed", undefined);
      }

      const sourcePath = resolveContainedPath(
        this.#options.visibleRootPath,
        binding.relativeSegments,
      );
      const source = await lstatOrUndefined(sourcePath);
      let trashPath: string | undefined;
      if (source) {
        assertRealDirectory(source, "The managed Workspace path");
        if (binding.state === "ready") await this.#assertWorkspaceIdentity(binding);
        const trashRoot = path.join(
          path.dirname(this.#options.visibleRootPath),
          ".opensteer-trash",
        );
        await mkdir(trashRoot, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
        const trashRootMetadata = await lstat(trashRoot, { bigint: true });
        assertRealDirectory(trashRootMetadata, "The local Workspace trash path");
        trashPath = path.join(trashRoot, `${binding.bindingId}-${Date.now()}`);
        await rename(sourcePath, trashPath);
      }

      const receipt = await this.#commitDestruction(
        document,
        binding,
        source ? "destroyed" : "already-destroyed",
        trashPath,
      );
      return receipt;
    });
  }

  /**
   * Removes the binding and records the tombstone in the same atomic write, so
   * a crash can never leave a directory gone with no durable proof of it.
   */
  async #commitDestruction(
    document: RegistryDocument,
    binding: RegistryBinding,
    outcome: DestructionReceipt["outcome"],
    trashPath: string | undefined,
  ): Promise<DestructionReceipt> {
    const receipt: DestructionReceipt = {
      bindingId: binding.bindingId,
      destroyedAt: new Date().toISOString(),
      generation: binding.generation,
      outcome,
      workspaceId: binding.workspaceId,
    };
    const receipts = [
      ...document.receipts.filter((candidate) => candidate.bindingId !== binding.bindingId),
      receipt,
    ].slice(-MAX_DESTRUCTION_RECEIPTS);
    await writeRegistryAtomic(this.#options.registryFilePath, {
      ...nextDocument(
        document,
        document.bindings.filter((candidate) => candidate.bindingId !== binding.bindingId),
      ),
      receipts,
    });
    if (trashPath) await rm(trashPath, { force: true, recursive: true });
    return receipt;
  }

  async getReadyBinding(input: {
    readonly bindingId: WorkspaceBindingId;
    readonly generation: number;
    readonly ownerEnvironmentId?: EnvironmentId;
    readonly workspaceId: WorkspaceId;
  }): Promise<ReadyRegistryBinding> {
    const document = await this.#readRegistry();
    await this.#assertRootIdentity(document);
    const binding = document.bindings.find((candidate) => candidate.bindingId === input.bindingId);
    if (binding === undefined) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The local Workspace binding is missing from the protected registry.",
      });
    }
    if (binding.workspaceId !== input.workspaceId) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.workspaceMismatch,
        message: "The local Workspace binding belongs to another Workspace.",
      });
    }
    if (
      input.ownerEnvironmentId !== undefined &&
      binding.ownerEnvironmentId !== input.ownerEnvironmentId
    ) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.environmentMismatch,
        message: "The local Workspace belongs to another execution environment.",
      });
    }
    if (binding.generation !== input.generation) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.generationMismatch,
        message: "The local Workspace binding generation is stale.",
      });
    }
    if (binding.relocation && binding.relocation.state !== "bound") {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.workspaceConflict,
        message: "This Project is being relocated into Main. Retry after relocation finishes.",
      });
    }
    if (binding.state !== "ready") {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.provisioningIncomplete,
        message: "The local Workspace has not finished provisioning.",
        retryable: true,
      });
    }
    await this.#assertWorkspaceIdentity(binding);
    return binding;
  }

  resolvePath(binding: ReadyRegistryBinding): string {
    return resolveContainedPath(this.#options.visibleRootPath, binding.relativeSegments);
  }

  async #finishProvision(
    document: RegistryDocument,
    binding: RegistryBinding,
    resume: boolean,
    signal?: AbortSignal,
  ): Promise<ReadyRegistryBinding> {
    signal?.throwIfAborted();
    await this.#assertRootIdentity(document);
    if (binding.state === "ready") {
      await this.#assertWorkspaceIdentity(binding);
      return binding;
    }

    const targetPath = resolveContainedPath(
      this.#options.visibleRootPath,
      binding.relativeSegments,
    );
    let identity: FilesystemIdentity;
    if (this.#options.filesystemAuthority) {
      try {
        identity = await this.#options.filesystemAuthority.ensureDirectory(
          {
            path: binding.relativeSegments.join("/"),
            resume,
            root: this.#options.visibleRootPath,
          },
          signal ?? new AbortController().signal,
        );
      } catch (cause) {
        if (nativeErrorCode(cause) === "already-exists") {
          throw new LocalWorkspaceError({
            cause,
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "The managed Workspace directory appeared while it was being provisioned.",
          });
        }
        throw asNativeDirectoryError(cause);
      }
    } else {
      await ensureManagedParentDirectories(
        this.#options.visibleRootPath,
        binding.relativeSegments.slice(0, -1),
      );
      const metadata = await lstatOrUndefined(targetPath);
      if (metadata === undefined) {
        await mkdir(targetPath, { mode: PRIVATE_DIRECTORY_MODE });
      } else {
        assertRealDirectory(metadata, "The managed Workspace path");
        if (!resume) {
          throw new LocalWorkspaceError({
            code: LocalWorkspaceErrorCode.workspaceConflict,
            message: "The managed Workspace directory appeared while it was being provisioned.",
          });
        }
      }
      identity = await readPosixDirectoryIdentity(targetPath);
    }
    const ready: ReadyRegistryBinding = {
      ...binding,
      filesystemIdentity: identity,
      state: "ready",
    };
    const bindings = document.bindings.map((candidate) =>
      candidate.bindingId === binding.bindingId ? ready : candidate,
    );
    await writeRegistryAtomic(this.#options.registryFilePath, nextDocument(document, bindings));
    signal?.throwIfAborted();
    return ready;
  }

  async #readOrCreateRegistry(signal?: AbortSignal): Promise<RegistryDocument> {
    const document = await this.#readRegistryOrCreate(signal);
    await this.#assertRootIdentity(document);
    return document;
  }

  /**
   * The registry's own contents, without judging the visible root. Reading the
   * disk's identity or listing what it holds must still answer while the
   * managed root is missing — that is a Workspace-level fault for `inspect` to
   * report, not a reason to lose the machine's identity.
   */
  async #readRegistryOrCreate(signal?: AbortSignal): Promise<RegistryDocument> {
    if ((await lstatOrUndefined(this.#options.registryFilePath)) !== undefined) {
      return this.#readRegistry();
    }

    signal?.throwIfAborted();
    await this.#ensureVisibleRoot(signal);
    if (!(await this.#visibleRootIsEmpty(signal))) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The protected local Workspace registry is missing for a non-empty managed root.",
      });
    }
    const document: RegistryDocument = {
      bindings: [],
      namespace: this.#options.namespace,
      receipts: [],
      revision: 0,
      rootIdentity: await this.#readDirectoryIdentity([]),
      storageAuthorityId: createId("storageAuthority"),
      version: REGISTRY_VERSION,
    };
    await writeRegistryAtomic(this.#options.registryFilePath, document);
    return document;
  }

  async #readRegistry(): Promise<RegistryDocument> {
    let content: string;
    try {
      content = await readProtectedFile(this.#options.registryFilePath);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      throw new LocalWorkspaceError({
        cause: error,
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The protected local Workspace registry is missing.",
      });
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (cause) {
      throw new LocalWorkspaceError({
        cause,
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The protected local Workspace registry is not valid JSON.",
      });
    }
    const parsed = RegistryDocumentSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new LocalWorkspaceError({
        cause: parsed.error,
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The protected local Workspace registry has an invalid shape.",
      });
    }
    assertRegistryUniqueness(parsed.data);
    if (!sameNamespace(parsed.data.namespace, this.#options.namespace)) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.configurationInvalid,
        message: "The configured local Workspace namespace does not match its registry.",
      });
    }
    return parsed.data;
  }

  async #ensureVisibleRoot(signal?: AbortSignal): Promise<boolean> {
    if (this.#options.filesystemAuthority) {
      try {
        const result = await this.#options.filesystemAuthority.ensureRoot(
          { root: this.#options.visibleRootPath },
          signal ?? new AbortController().signal,
        );
        return !result.created;
      } catch (cause) {
        throw asNativeDirectoryError(cause);
      }
    }
    return ensureVisibleRoot(this.#options.visibleRootPath, true);
  }

  async #visibleRootIsEmpty(signal?: AbortSignal): Promise<boolean> {
    if (this.#options.filesystemAuthority) {
      try {
        const result = await this.#options.filesystemAuthority.list(
          {
            maxDepth: 1,
            maxEntries: 1,
            path: ".",
            root: this.#options.visibleRootPath,
          },
          signal ?? new AbortController().signal,
        );
        return result.entries.length === 0;
      } catch (cause) {
        throw asNativeDirectoryError(cause);
      }
    }
    return (await readdir(this.#options.visibleRootPath)).length === 0;
  }

  async #assertRootIdentity(document: Pick<RegistryDocument, "rootIdentity">): Promise<void> {
    let actual: FilesystemIdentity;
    try {
      actual = await this.#readDirectoryIdentity([]);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new LocalWorkspaceError({
          cause: error,
          code: LocalWorkspaceErrorCode.directoryMissing,
          message: "The managed Workspace root is missing.",
        });
      }
      throw asDirectoryAccessError(error, "The managed Workspace root is inaccessible.");
    }
    if (!equalIdentity(document.rootIdentity, actual)) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.directoryReplaced,
        message: "The managed Workspace root has been replaced.",
      });
    }
  }

  async #assertWorkspaceIdentity(binding: ReadyRegistryBinding): Promise<void> {
    let actual: FilesystemIdentity;
    try {
      if (!this.#options.filesystemAuthority) {
        await assertRealDirectoryChain(this.#options.visibleRootPath, binding.relativeSegments);
      }
      actual = await this.#readDirectoryIdentity(binding.relativeSegments);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new LocalWorkspaceError({
          cause: error,
          code: LocalWorkspaceErrorCode.directoryMissing,
          message: "The managed Workspace directory is missing.",
        });
      }
      if (error instanceof LocalWorkspaceError) throw error;
      throw asDirectoryAccessError(error, "The managed Workspace directory is inaccessible.");
    }
    if (!equalIdentity(binding.filesystemIdentity, actual)) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.directoryReplaced,
        message: "The managed Workspace directory has been replaced.",
      });
    }
  }

  async #readDirectoryIdentity(segments: readonly string[]): Promise<FilesystemIdentity> {
    if (this.#options.filesystemAuthority) {
      try {
        return await this.#options.filesystemAuthority.directoryIdentity(
          {
            path: segments.length === 0 ? "." : segments.join("/"),
            root: this.#options.visibleRootPath,
          },
          new AbortController().signal,
        );
      } catch (cause) {
        throw asNativeDirectoryError(cause);
      }
    }
    for (let index = 1; index < segments.length; index++) {
      const parent = await lstat(
        resolveContainedPath(this.#options.visibleRootPath, segments.slice(0, index)),
        { bigint: true },
      );
      assertRealDirectory(parent, "The managed Workspace parent");
    }
    return readPosixDirectoryIdentity(
      resolveDirectoryIdentityPath(this.#options.visibleRootPath, segments),
    );
  }
}

function normalizeOptions(options: LocalWorkspaceRegistryOptions): NormalizedRegistryOptions {
  const visibleRootPath = normalizedAbsolutePath(options.visibleRootPath, "visibleRootPath");
  const registryFilePath = normalizedAbsolutePath(options.registryFilePath, "registryFilePath");
  if (registryFilePath === visibleRootPath || isWithinPath(visibleRootPath, registryFilePath)) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.configurationInvalid,
      message: "The protected registry and visible Workspace root must not overlap.",
    });
  }
  const legacyRegistryFilePath = options.legacyRegistryFilePath
    ? normalizedAbsolutePath(options.legacyRegistryFilePath, "legacyRegistryFilePath")
    : undefined;
  if (
    legacyRegistryFilePath &&
    (legacyRegistryFilePath === visibleRootPath ||
      isWithinPath(visibleRootPath, legacyRegistryFilePath))
  ) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.configurationInvalid,
      message: "The legacy protected registry and visible Workspace root must not overlap.",
    });
  }
  return {
    ...options,
    ...(legacyRegistryFilePath ? { legacyRegistryFilePath } : {}),
    registryFilePath,
    visibleRootPath,
  };
}

function normalizedAbsolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value)) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.configurationInvalid,
      message: `${name} must be an absolute path.`,
    });
  }
  const normalized = path.resolve(value);
  if (normalized !== value) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.configurationInvalid,
      message: `${name} must be normalized.`,
    });
  }
  return normalized;
}

function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function assertOwnerAllowed(
  namespace: LocalWorkspaceNamespace,
  ownerEnvironmentId: EnvironmentId,
): void {
  if (namespace.kind !== "owner-scoped" && namespace.ownerEnvironmentId !== ownerEnvironmentId) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.environmentMismatch,
      message: "This local Workspace registry belongs to another execution environment.",
    });
  }
}

function stableStringify(value: ProvisionFingerprint): string {
  return JSON.stringify([
    value.createdBy,
    value.kind,
    value.ownerEnvironmentId,
    value.workspaceId,
    value.slug ?? null,
  ]);
}

function resolveContainedPath(rootPath: string, segments: readonly string[]): string {
  if (segments.length === 0 || segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The local Workspace registry contains an unsafe path segment.",
    });
  }
  const resolved = path.resolve(rootPath, ...segments);
  if (!isWithinPath(rootPath, resolved)) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The local Workspace registry path escapes the managed root.",
    });
  }
  return resolved;
}

function assertSameProvision(
  binding: RegistryBinding,
  input: {
    readonly bindingId: WorkspaceBindingId;
    readonly fingerprint: ProvisionFingerprint;
    readonly generation: number;
  },
): void {
  if (
    binding.bindingId !== input.bindingId ||
    binding.generation !== input.generation ||
    stableStringify(binding.provisionFingerprint) !== stableStringify(input.fingerprint)
  ) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.idempotencyConflict,
      message: "The local Workspace idempotency key was already used for another request.",
    });
  }
}

function assertProvisionDoesNotConflict(
  document: RegistryDocument,
  input: { readonly bindingId: WorkspaceBindingId; readonly fingerprint: ProvisionFingerprint },
): void {
  if (document.bindings.some((binding) => binding.bindingId === input.bindingId)) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.workspaceConflict,
      message: "The local Workspace binding ID is already in use.",
    });
  }
  if (document.bindings.some((binding) => binding.workspaceId === input.fingerprint.workspaceId)) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.workspaceConflict,
      message: "The Workspace already has a local directory binding.",
    });
  }
}

function assertRegistryUniqueness(
  document: Pick<RegistryDocument, "bindings" | "namespace">,
): void {
  for (const binding of document.bindings) {
    const project = document.namespace.kind === "team-project";
    if (
      project
        ? binding.createdBy !== undefined ||
          binding.provisionFingerprint.createdBy !== undefined ||
          binding.provisionFingerprint.kind !== "project" ||
          binding.provisionFingerprint.slug !== undefined
        : !binding.createdBy || !binding.provisionFingerprint.createdBy
    )
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "Workspace binding does not match its storage namespace",
      });
  }
  assertUnique(
    document.bindings.map((binding) => binding.bindingId),
    "binding ID",
  );
  assertUnique(
    document.bindings.map((binding) => binding.idempotencyKey),
    "idempotency key",
  );
  assertUnique(
    document.bindings.map((binding) => binding.workspaceId),
    "Workspace ID",
  );
  assertUnique(
    document.bindings.map((binding) => binding.relativeSegments.join("/").toLowerCase()),
    "relative path",
  );
  const paths = new Map(
    document.bindings.map((binding) => [binding.relativeSegments.join("/").toLowerCase(), binding]),
  );
  for (const binding of document.bindings) {
    for (let depth = 1; depth < binding.relativeSegments.length; depth += 1) {
      const ancestor = paths.get(binding.relativeSegments.slice(0, depth).join("/").toLowerCase());
      if (!ancestor) continue;
      const isOwnedProject =
        ancestor.provisionFingerprint.kind === "main" &&
        binding.provisionFingerprint.kind === "project" &&
        ancestor.createdBy === binding.createdBy &&
        ancestor.ownerEnvironmentId === binding.ownerEnvironmentId &&
        binding.relativeSegments.length === depth + 2 &&
        binding.relativeSegments[depth] === "Projects";
      if (!isOwnedProject) {
        throw new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.registryInvalid,
          message:
            "The protected local Workspace registry contains overlapping directory bindings.",
        });
      }
    }
  }
}

function assertUnique(values: readonly string[], description: string): void {
  if (new Set(values).size !== values.length) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: `The protected local Workspace registry contains a duplicate ${description}.`,
    });
  }
}

function nextDocument(
  document: RegistryDocument,
  bindings: readonly RegistryBinding[],
): RegistryDocument {
  if (document.revision >= Number.MAX_SAFE_INTEGER) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The protected local Workspace registry revision is exhausted.",
    });
  }
  return { ...document, bindings: [...bindings], revision: document.revision + 1 };
}

async function ensureVisibleRoot(rootPath: string, create: boolean): Promise<boolean> {
  let metadata = await lstatOrUndefined(rootPath);
  const existed = metadata !== undefined;
  if (metadata === undefined && create) {
    await mkdir(rootPath, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    metadata = await lstat(rootPath, { bigint: true });
  }
  if (metadata === undefined) {
    const error = new Error("The managed Workspace root is missing.") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  assertRealDirectory(metadata, "The managed Workspace root");
  return existed;
}

async function ensureManagedParentDirectories(
  rootPath: string,
  segments: readonly string[],
): Promise<void> {
  let current = rootPath;
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The local Workspace registry contains an unsafe path segment.",
      });
    }
    current = path.join(current, segment);
    const metadata = await lstatOrUndefined(current);
    if (metadata === undefined) {
      await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
    } else {
      assertRealDirectory(metadata, "A managed Workspace parent path");
    }
  }
}

async function assertRealDirectoryChain(
  rootPath: string,
  segments: readonly string[],
): Promise<void> {
  let current = rootPath;
  assertRealDirectory(await lstat(current, { bigint: true }), "The managed Workspace root");
  for (const segment of segments) {
    current = path.join(current, segment);
    assertRealDirectory(await lstat(current, { bigint: true }), "A managed Workspace path");
  }
}

function assertRealDirectory(metadata: BigIntStats, description: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.directoryReplaced,
      message: `${description} must be a real directory, not a link or another file type.`,
    });
  }
}

async function readPosixDirectoryIdentity(directoryPath: string): Promise<FilesystemIdentity> {
  if (process.platform === "win32") {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.configurationInvalid,
      message: "Windows local Workspaces require the native filesystem authority.",
    });
  }
  const metadata = await lstat(directoryPath, { bigint: true });
  assertRealDirectory(metadata, "The managed Workspace path");
  return {
    fileId: metadata.ino.toString(10),
    kind: "posix",
    // Darwin assigns st_dev per mount session, so it can change for the same
    // APFS volume after a reboot. Native operations still enforce same-device
    // containment; the persisted macOS identity is the directory inode.
    volumeId: process.platform === "darwin" ? "0" : metadata.dev.toString(10),
  };
}

function resolveDirectoryIdentityPath(rootPath: string, segments: readonly string[]): string {
  return segments.length === 0 ? rootPath : resolveContainedPath(rootPath, segments);
}

async function lstatOrUndefined(targetPath: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(targetPath, { bigint: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readProtectedFile(filePath: string): Promise<string> {
  await assertPrivateDirectory(path.dirname(filePath));
  let metadata: BigIntStats;
  try {
    metadata = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) throw error;
    throw new LocalWorkspaceError({
      cause: error,
      code: LocalWorkspaceErrorCode.registryUnavailable,
      message: "The protected local Workspace registry cannot be inspected.",
      retryable: true,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The protected local Workspace registry must be a real regular file.",
    });
  }
  assertPrivateMetadata(metadata, "registry file", PRIVATE_FILE_MODE);
  if (metadata.size > BigInt(MAX_REGISTRY_BYTES)) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The protected local Workspace registry is too large.",
    });
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const content = await readBounded(
      handle,
      MAX_REGISTRY_BYTES,
      () =>
        new LocalWorkspaceError({
          code: LocalWorkspaceErrorCode.registryInvalid,
          message: "The protected local Workspace registry is too large.",
        }),
    );
    return content.toString("utf8");
  } catch (cause) {
    if (cause instanceof LocalWorkspaceError) throw cause;
    throw new LocalWorkspaceError({
      cause,
      code: LocalWorkspaceErrorCode.registryUnavailable,
      message: "The protected local Workspace registry cannot be read.",
      retryable: true,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPrivateDirectory(directoryPath: string): Promise<void> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(directoryPath, { bigint: true });
  } catch (cause) {
    throw new LocalWorkspaceError({
      cause,
      code: LocalWorkspaceErrorCode.registryUnavailable,
      message: "The protected local Workspace registry parent is inaccessible.",
      retryable: true,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The protected local Workspace registry parent must be a real directory.",
    });
  }
  assertPrivateMetadata(metadata, "registry parent directory", PRIVATE_DIRECTORY_MODE);
}

async function writeRegistryAtomic(
  registryFilePath: string,
  document: RegistryDocument,
): Promise<void> {
  const content = `${JSON.stringify(RegistryDocumentSchema.parse(document))}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_REGISTRY_BYTES) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The protected local Workspace registry is too large.",
    });
  }
  const parentPath = path.dirname(registryFilePath);
  await ensurePrivateRegistryDirectory(parentPath);
  const existing = await lstatOrUndefined(registryFilePath);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new LocalWorkspaceError({
        code: LocalWorkspaceErrorCode.registryInvalid,
        message: "The protected local Workspace registry must be a real regular file.",
      });
    }
    assertPrivateMetadata(existing, "registry file", PRIVATE_FILE_MODE);
  }

  const temporaryPath = path.join(
    parentPath,
    `.${path.basename(registryFilePath)}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, registryFilePath);
    await setPrivateFileMode(registryFilePath, PRIVATE_FILE_MODE);
    await syncDirectory(parentPath);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (cause instanceof LocalWorkspaceError) throw cause;
    throw new LocalWorkspaceError({
      cause,
      code: LocalWorkspaceErrorCode.registryUnavailable,
      message: "The protected local Workspace registry cannot be written.",
      retryable: true,
    });
  }
}

async function ensurePrivateRegistryDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const metadata = await lstat(directoryPath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: "The protected local Workspace registry parent must be a real directory.",
    });
  }
  if (process.platform !== "win32") {
    assertOwnedByRuntime(metadata, "registry parent directory");
    await setPrivateDirectoryMode(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
}

function assertPrivateMetadata(
  metadata: BigIntStats,
  description: string,
  expectedMode: number,
): void {
  if (process.platform === "win32") return;
  assertOwnedByRuntime(metadata, description);
  if ((Number(metadata.mode) & 0o077) !== 0 || (Number(metadata.mode) & 0o700) !== expectedMode) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: `The protected local Workspace ${description} has unsafe permissions.`,
    });
  }
}

function assertOwnedByRuntime(metadata: BigIntStats, description: string): void {
  const runtimeUserId = process.getuid?.();
  if (runtimeUserId !== undefined && metadata.uid !== BigInt(runtimeUserId)) {
    throw new LocalWorkspaceError({
      code: LocalWorkspaceErrorCode.registryInvalid,
      message: `The protected local Workspace ${description} belongs to another operating-system user.`,
    });
  }
}

async function withRegistryWriteLock<T>(
  registryFilePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = registryWriteTails.get(registryFilePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  registryWriteTails.set(registryFilePath, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (registryWriteTails.get(registryFilePath) === tail) {
      registryWriteTails.delete(registryFilePath);
    }
  }
}

function equalIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return (
    left.kind === right.kind && left.volumeId === right.volumeId && left.fileId === right.fileId
  );
}

function equalSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function sameNamespace(left: LocalWorkspaceNamespace, right: LocalWorkspaceNamespace): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind === "owner-scoped" ||
    (right.kind !== "owner-scoped" && left.ownerEnvironmentId === right.ownerEnvironmentId)
  );
}

function asDirectoryAccessError(error: unknown, message: string): LocalWorkspaceError {
  return error instanceof LocalWorkspaceError
    ? error
    : new LocalWorkspaceError({
        cause: error,
        code: LocalWorkspaceErrorCode.directoryInaccessible,
        message,
        retryable: true,
      });
}

function asNativeDirectoryError(error: unknown): LocalWorkspaceError {
  switch (nativeErrorCode(error)) {
    case "not-found": {
      const missing = new Error(
        "The managed Workspace directory is missing.",
      ) as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      return new LocalWorkspaceError({
        cause: error,
        code: LocalWorkspaceErrorCode.directoryMissing,
        message: missing.message,
      });
    }
    case "cross-device":
    case "symlink-denied":
    case "unsafe-parent":
      return new LocalWorkspaceError({
        cause: error,
        code: LocalWorkspaceErrorCode.directoryReplaced,
        message: "The managed Workspace directory contains a replaced or unsafe path component.",
      });
    default:
      return asDirectoryAccessError(error, "The managed Workspace directory is inaccessible.");
  }
}

function nativeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error !== null && typeof error === "object" && "code" in error && String(error.code) === code,
  );
}
