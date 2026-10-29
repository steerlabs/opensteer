import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { readBoundedText } from "@opensteer/shared/boundedJson";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  UserIdSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
  type RunnerId,
  type RuntimeMode,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  MountGrantExchangeRequestSchema,
  MountGrantExchangeResponseSchema,
  type RunnerWorkspaceMount,
} from "@opensteer/protocol";
import {
  workspacePathSegments,
  type PortableFsWorkspaceExecutionAccessPlan,
  type WorkspaceNamespace,
} from "@opensteer/workspace";
import {
  PortableFsMountCapabilitySchema,
  PortableFsVolumeIdSchema,
  type PortableFsMountStatus,
  type PortableFsMountedWorkspace,
  type PortableFsRunner,
  type PortableFsVolumeId,
} from "@opensteer/workspace-portablefs";
import { z } from "zod";

const MAX_EXCHANGE_RESPONSE_BYTES = 128 * 1_024;
const MAX_CSR_BYTES = 32 * 1_024;
const REQUIRED_PORTABLEFS_FEATURE = "hosted-automatic-mount-reauthorization-v2";
const MOUNT_EXCHANGE_RETRY_WINDOW_MS = 30_000;
const MOUNT_EXCHANGE_INITIAL_RETRY_MS = 100;
const MOUNT_EXCHANGE_MAX_RETRY_MS = 2_000;
const mountRecordFileName = "mount.json";
const mountRenewalReadinessMs = 30_000;

const PersistedMountRecordSchema = z.strictObject({
  createdBy: UserIdSchema,
  enrollmentId: z.string().min(1).max(256),
  mountPath: z.string().min(1),
  volumeId: z.string().min(1).max(255),
  workspaceId: WorkspaceIdSchema,
  workspaceKind: WorkspaceKindSchema,
});

interface WorkspaceMountRecord {
  readonly createdBy: UserId;
  readonly credentialDirectory: string;
  readonly enrollmentId: string;
  readonly mountPath: string;
  readonly volumeId: string;
  readonly workspaceId: WorkspaceId;
  readonly workspaceKind: "main" | "specialized";
}

export interface MountIdentityIssuer {
  create(input: {
    readonly directory: string;
    readonly runnerId: RunnerId;
    readonly signal: AbortSignal;
  }): Promise<{ readonly csrPem: string; readonly privateKeyPath: string }>;
}

interface WorkspaceMountRegistryOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly identityIssuer: MountIdentityIssuer;
  readonly mode: RuntimeMode;
  readonly namespace: WorkspaceNamespace;
  readonly portableFs: PortableFsRunner;
  readonly root: string;
  readonly runnerId: RunnerId;
  readonly runtimeDirectory: string;
}

export class WorkspaceMountVolumeConflictError extends Error {
  readonly actualVolumeId: string;
  readonly expectedVolumeId: string;
  readonly workspaceId: WorkspaceId;

  constructor(input: {
    readonly actualVolumeId: string;
    readonly expectedVolumeId: string;
    readonly workspaceId: WorkspaceId;
  }) {
    super(
      `Workspace ${input.workspaceId} is mounted from volume ${input.actualVolumeId}, not requested volume ${input.expectedVolumeId}`,
    );
    this.name = "WorkspaceMountVolumeConflictError";
    this.actualVolumeId = input.actualVolumeId;
    this.expectedVolumeId = input.expectedVolumeId;
    this.workspaceId = input.workspaceId;
  }
}

class MountExchangeResponseError extends Error {}

export class WorkspaceMountRegistry {
  readonly #fetch: typeof globalThis.fetch;
  readonly #identityIssuer: MountIdentityIssuer;
  readonly #locks = new Map<WorkspaceId, Promise<void>>();
  readonly #mode: RuntimeMode;
  readonly #mounts = new Map<WorkspaceId, WorkspaceMountRecord>();
  readonly #namespace: WorkspaceNamespace;
  readonly #portableFs: PortableFsRunner;
  readonly #root: string;
  readonly #runnerId: RunnerId;
  readonly #runtimeDirectory: string;

  constructor(options: WorkspaceMountRegistryOptions) {
    if (!isAbsolute(options.root) || !isAbsolute(options.runtimeDirectory)) {
      throw new TypeError("Workspace mount root and runtime directory must be absolute paths");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#identityIssuer = options.identityIssuer;
    this.#mode = options.mode;
    this.#namespace = options.namespace;
    this.#portableFs = options.portableFs;
    this.#root = resolve(options.root);
    this.#runnerId = options.runnerId;
    this.#runtimeDirectory = resolve(options.runtimeDirectory);
  }

  get namespace(): WorkspaceNamespace {
    return this.#namespace;
  }

  get root(): string {
    return this.#root;
  }

  namespaceRoot(userId: UserId): string {
    return this.#namespace === "single-owner" ? this.#root : resolve(this.#root, userId);
  }

  async preflight(signal?: AbortSignal): Promise<{ readonly portableFsVersion: string }> {
    signal?.throwIfAborted();
    await mkdir(this.#root, { mode: 0o700, recursive: true });
    await mkdir(this.#identityRoot(), { mode: 0o700, recursive: true });
    const options = signal ? { signal } : {};
    const version = await this.#portableFs.getVersion(options);
    if (!version.features?.includes(REQUIRED_PORTABLEFS_FEATURE)) {
      throw new Error(
        `PortableFS ${version.version} does not advertise ${REQUIRED_PORTABLEFS_FEATURE}`,
      );
    }
    const support = await this.#portableFs.checkMountSupport({ ...options, strategy: "auto" });
    if ("error" in support && support.error) {
      throw new Error(`PortableFS mount support is unavailable: ${support.error.message}`);
    }
    return { portableFsVersion: version.version };
  }

  async ensureMounted(
    plan: PortableFsWorkspaceExecutionAccessPlan,
    signal: AbortSignal,
  ): Promise<{ readonly path: string }> {
    return this.#withWorkspaceLock(plan.workspaceId, async () => {
      signal.throwIfAborted();
      validateExchangeUrl(new URL(plan.exchangeUrl), this.#mode);
      const volumeId = PortableFsVolumeIdSchema.parse(plan.volumeId);
      const mountPath = this.#mountPath(plan);
      const existing = this.#mounts.get(plan.workspaceId);
      if (existing) {
        if (existing.mountPath !== mountPath) {
          throw new Error(
            `Workspace ${plan.workspaceId} is recorded at ${existing.mountPath}, not canonical path ${mountPath}`,
          );
        }
        if (existing.volumeId !== volumeId) {
          throw new WorkspaceMountVolumeConflictError({
            actualVolumeId: existing.volumeId,
            expectedVolumeId: volumeId,
            workspaceId: plan.workspaceId,
          });
        }
        const row = await this.#verifiedInventoryRow(existing);
        if (row?.alive && row.health === "live") {
          if (!(row.lastReauthorizationAtMs && row.lastReauthorizationAtMs > 0)) {
            await this.#verifyExpectedMount(mountPath, volumeId, existing.enrollmentId, signal);
          }
          return { path: mountPath };
        }
        if (row) {
          // A failed mount is not a different volume. PortableFS owns durable
          // withdrawal; never force it or reuse its expired authorization.
          await this.#detachObservedRow(row);
        }
        await this.#forgetLostMount(existing);
      }

      await this.#assertMountAvailable(mountPath, volumeId);
      await this.#prepareMountPath(plan, mountPath);
      const credentialDirectory = this.#credentialDirectory(plan.workspaceId);
      await rm(credentialDirectory, { force: true, recursive: true });
      await mkdir(credentialDirectory, { mode: 0o700, recursive: true });
      await setPrivateDirectoryMode(credentialDirectory);

      let mounted: PortableFsMountedWorkspace | undefined;
      let enrollmentId: string | undefined;
      try {
        const identity = await this.#identityIssuer.create({
          directory: credentialDirectory,
          runnerId: this.#runnerId,
          signal,
        });
        const exchange = await this.#exchangeGrant(
          plan,
          { clientCertificateRequestPem: identity.csrPem },
          signal,
        );
        if (exchange.volumeId !== plan.volumeId) {
          throw new Error("Mount grant exchange returned an unexpected volume identity");
        }
        if (Date.parse(exchange.expiresAt) <= Date.now() + 5_000) {
          throw new Error("Mount grant exchange returned an expired or unusably short grant");
        }
        const authorizationExpiresAtMs = Date.parse(exchange.expiresAt);
        if (!Number.isSafeInteger(authorizationExpiresAtMs)) {
          throw new Error("Mount grant exchange returned an invalid authorization lifetime");
        }
        assertAutomaticManagerEndpoint(exchange.automaticReauthorization.manager.url);
        enrollmentId = exchange.automaticReauthorization.enrollmentId;

        const certificatePath = join(credentialDirectory, "client-certificate.pem");
        const authorityCaPath = join(credentialDirectory, "authority-ca.pem");
        const managerCaPath = join(credentialDirectory, "manager-ca.pem");
        const enrollmentCertificatePath = join(
          credentialDirectory,
          "mount-enrollment-certificate.pem",
        );
        await Promise.all([
          writePrivateFile(certificatePath, exchange.clientCertificatePem),
          writePrivateFile(
            managerCaPath,
            exchange.automaticReauthorization.manager.caCertificatePem,
          ),
          writePrivateFile(
            enrollmentCertificatePath,
            exchange.automaticReauthorization.enrollmentCertificatePem,
          ),
        ]);
        const tls =
          exchange.authority.transport === "tls-private-ca"
            ? {
                caPath: authorityCaPath,
                serverName: exchange.authority.serverName,
                transport: "tls-private-ca" as const,
              }
            : {
                serverName: exchange.authority.serverName,
                transport: "tls-system-pki" as const,
              };
        if (exchange.authority.transport === "tls-private-ca") {
          await writePrivateFile(authorityCaPath, exchange.authority.caCertificatePem);
        }
        mounted = await this.#portableFs.mount(
          {
            automaticReauthorization: {
              authorityGeneration: exchange.automaticReauthorization.authorityGeneration,
              authorizationExpiresAtMs,
              enrollmentCertificatePath,
              enrollmentId,
              managerCaPath,
              managerServerName: exchange.automaticReauthorization.manager.serverName,
              managerUrl: exchange.automaticReauthorization.manager.url,
            },
            authorityAddress: exchange.authority.address,
            capability: PortableFsMountCapabilitySchema.parse(exchange.capability),
            clientCertificatePath: certificatePath,
            clientKeyPath: identity.privateKeyPath,
            coherence: "strict",
            mountPath,
            noLocalDirs: true,
            strategy: "auto",
            tls,
            volumeId,
          },
          { signal },
        );
        if (resolve(mounted.mountPath) !== mountPath || mounted.volumeId !== volumeId) {
          throw new Error("PortableFS mounted an unexpected path or volume");
        }
        await this.#verifyExpectedMount(mountPath, volumeId, enrollmentId, signal);
        const record: WorkspaceMountRecord = {
          createdBy: plan.createdBy,
          credentialDirectory,
          enrollmentId,
          mountPath,
          volumeId,
          workspaceId: plan.workspaceId,
          workspaceKind: plan.workspaceKind,
        };
        await this.#persistRecord(record);
        this.#mounts.set(plan.workspaceId, record);
        return { path: mountPath };
      } catch (error) {
        const cleanupFailure = await this.#cleanupMountCreatedHere({
          enrollmentId,
          mountPath,
          mountReturned: mounted !== undefined,
          volumeId,
        });
        const credentialFailure = cleanupFailure
          ? undefined
          : await rm(credentialDirectory, {
              force: true,
              recursive: true,
            }).then(
              () => undefined,
              (failure: unknown) => failure,
            );
        if (cleanupFailure || credentialFailure) {
          throw new AggregateError(
            [error, cleanupFailure, credentialFailure].filter((failure) => failure !== undefined),
            `Workspace mount failed: ${errorMessage(error)}`,
          );
        }
        throw error;
      }
    });
  }

  async detach(workspaceId: WorkspaceId): Promise<void> {
    await this.#withWorkspaceLock(workspaceId, async () => {
      const record = this.#mounts.get(workspaceId);
      if (!record) return;
      const inventory = await this.#portableFs.listMounts();
      const row = inventory.mounts.find(
        (candidate) => resolve(candidate.mountPath) === record.mountPath,
      );
      if (row) this.#assertRecordedIdentity(record, row);
      if (row) {
        const result = await this.#portableFs.unmount({ mountPath: record.mountPath });
        if (resolve(result.mountPath) !== record.mountPath) {
          throw new Error("PortableFS reported unmounting a different path");
        }
      }
      const after = await this.#portableFs.listMounts();
      if (after.mounts.some((candidate) => resolve(candidate.mountPath) === record.mountPath)) {
        throw new Error("PortableFS Workspace mount remains present after unmount");
      }
      await rm(record.credentialDirectory, { force: true, recursive: true });
      this.#mounts.delete(workspaceId);
    });
  }

  async detachAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const workspaceId of this.#mounts.keys()) {
      try {
        await this.detach(workspaceId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Workspace mounts were not fully detached");
    }
  }

  inventory(): readonly RunnerWorkspaceMount[] {
    return [...this.#mounts.values()].map(({ enrollmentId, volumeId, workspaceId }) => ({
      enrollmentId,
      volumeId,
      workspaceId,
    }));
  }

  async adoptExisting(): Promise<void> {
    await mkdir(this.#root, { mode: 0o700, recursive: true });
    await mkdir(this.#identityRoot(), { mode: 0o700, recursive: true });
    const persisted = await this.#readPersistedRecords();
    const inventory = await this.#portableFs.listMounts();
    const rows = inventory.mounts.filter((row) => isPathWithin(this.#root, row.mountPath));
    for (const row of rows) {
      const enrollmentId = row.mountEnrollmentId;
      if (!row.alive || row.health !== "live" || !enrollmentId) {
        await this.#detachObservedRow(row);
        continue;
      }
      const record = this.#matchAdoptedRow(row, enrollmentId, persisted);
      if (!record || this.#mounts.has(record.workspaceId)) {
        await this.#detachObservedRow(row);
        continue;
      }
      this.#mounts.set(record.workspaceId, record);
    }
  }

  async #detachObservedRow(row: PortableFsMountStatus): Promise<void> {
    const mountPath = resolve(row.mountPath);
    const result = await this.#portableFs.unmount({ mountPath });
    if (resolve(result.mountPath) !== mountPath) {
      throw new Error("PortableFS reported unmounting a different path during mount adoption");
    }
    const after = await this.#portableFs.listMounts();
    if (after.mounts.some((candidate) => resolve(candidate.mountPath) === mountPath)) {
      throw new Error(`PortableFS mount ${mountPath} remains present after startup detach`);
    }
  }

  #matchAdoptedRow(
    row: PortableFsMountStatus,
    enrollmentId: string,
    persisted: readonly WorkspaceMountRecord[],
  ): WorkspaceMountRecord | undefined {
    const mountPath = resolve(row.mountPath);
    return persisted.find(
      (candidate) =>
        candidate.mountPath === mountPath &&
        candidate.volumeId === row.volumeId &&
        candidate.enrollmentId === enrollmentId &&
        this.#mountPath(candidate) === mountPath,
    );
  }

  async #readPersistedRecords(): Promise<readonly WorkspaceMountRecord[]> {
    const entries = await readdir(this.#identityRoot(), { withFileTypes: true });
    const records: WorkspaceMountRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directoryWorkspaceId = WorkspaceIdSchema.safeParse(entry.name);
      if (!directoryWorkspaceId.success) continue;
      const credentialDirectory = resolve(this.#identityRoot(), entry.name);
      try {
        const parsed = PersistedMountRecordSchema.parse(
          JSON.parse(await readFile(join(credentialDirectory, mountRecordFileName), "utf8")),
        );
        if (parsed.workspaceId !== directoryWorkspaceId.data) continue;
        records.push({
          ...parsed,
          credentialDirectory,
          mountPath: resolve(parsed.mountPath),
        });
      } catch {
        // An incomplete identity directory cannot authorize adoption. A live
        // row using it is detached below; an unused directory is replaced on demand.
      }
    }
    return records;
  }

  async #persistRecord(record: WorkspaceMountRecord): Promise<void> {
    const value = PersistedMountRecordSchema.parse({
      createdBy: record.createdBy,
      enrollmentId: record.enrollmentId,
      mountPath: record.mountPath,
      volumeId: record.volumeId,
      workspaceId: record.workspaceId,
      workspaceKind: record.workspaceKind,
    });
    const path = join(record.credentialDirectory, mountRecordFileName);
    await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await setPrivateFileMode(path);
  }

  async #verifiedInventoryRow(
    record: WorkspaceMountRecord,
  ): Promise<PortableFsMountStatus | undefined> {
    const inventory = await this.#portableFs.listMounts();
    const row = inventory.mounts.find(
      (candidate) => resolve(candidate.mountPath) === record.mountPath,
    );
    if (!row) return undefined;
    this.#assertRecordedIdentity(record, row);
    if (row.alive && !["live", "revoked", "credential-expired", "stale"].includes(row.health)) {
      throw new Error(
        `PortableFS Workspace ${record.workspaceId} mount is not ready (health: ${row.health}); refusing to replace an unrecognized mount state`,
      );
    }
    return row;
  }

  #assertRecordedIdentity(record: WorkspaceMountRecord, row: PortableFsMountStatus): void {
    if (row.volumeId !== record.volumeId) {
      throw new WorkspaceMountVolumeConflictError({
        actualVolumeId: row.volumeId,
        expectedVolumeId: record.volumeId,
        workspaceId: record.workspaceId,
      });
    }
    if (row.mountEnrollmentId !== record.enrollmentId) {
      throw new Error(
        `PortableFS mount at ${record.mountPath} belongs to a different enrollment than Workspace ${record.workspaceId}; refusing to detach it`,
      );
    }
  }

  async #forgetLostMount(record: WorkspaceMountRecord): Promise<void> {
    await rm(record.credentialDirectory, { force: true, recursive: true });
    this.#mounts.delete(record.workspaceId);
  }

  async #assertMountAvailable(mountPath: string, volumeId: PortableFsVolumeId): Promise<void> {
    const inventory = await this.#portableFs.listMounts();
    const occupying = inventory.mounts.find(
      (candidate) => resolve(candidate.mountPath) === mountPath,
    );
    if (occupying) {
      throw new Error(
        occupying.volumeId === volumeId
          ? `PortableFS volume ${volumeId} is already mounted at the canonical Workspace path but is not owned by this registry`
          : `Canonical Workspace path ${mountPath} is occupied by PortableFS volume ${occupying.volumeId}, expected ${volumeId}`,
      );
    }
    const elsewhere = inventory.mounts.find((candidate) => candidate.volumeId === volumeId);
    if (elsewhere) {
      throw new Error(
        `PortableFS volume ${volumeId} is already mounted at ${resolve(elsewhere.mountPath)}, not canonical path ${mountPath}`,
      );
    }
    const overlap = inventory.mounts.find((candidate) =>
      pathsOverlap(resolve(candidate.mountPath), mountPath),
    );
    if (overlap) {
      throw new Error(
        `Canonical Workspace path ${mountPath} overlaps live PortableFS mount ${resolve(overlap.mountPath)}; nested mounts are not supported`,
      );
    }
  }

  async #prepareMountPath(
    plan: PortableFsWorkspaceExecutionAccessPlan,
    mountPath: string,
  ): Promise<void> {
    const namespaceRoot = this.namespaceRoot(plan.createdBy);
    if (namespaceRoot !== this.#root) assertPathWithin(this.#root, namespaceRoot);
    assertPathWithin(namespaceRoot, mountPath);
    await mkdir(namespaceRoot, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(namespaceRoot);
    await mkdir(mountPath, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(mountPath);
    const entries = await readdir(mountPath);
    if (entries.length > 0) {
      throw new Error(`Canonical Workspace mount directory ${mountPath} is not empty`);
    }
  }

  #mountPath(workspace: {
    readonly createdBy: UserId;
    readonly workspaceId: WorkspaceId;
    readonly workspaceKind: "main" | "specialized";
  }): string {
    const path = resolve(
      this.#root,
      ...workspacePathSegments(
        {
          createdBy: workspace.createdBy,
          id: workspace.workspaceId,
          kind: workspace.workspaceKind,
        },
        this.#namespace,
      ),
    );
    assertPathWithin(this.#root, path);
    return path;
  }

  #identityRoot(): string {
    return resolve(this.#runtimeDirectory, "workspace-mounts");
  }

  #credentialDirectory(workspaceId: WorkspaceId): string {
    const directory = resolve(this.#identityRoot(), workspaceId);
    assertPathWithin(this.#identityRoot(), directory);
    return directory;
  }

  async #verifyExpectedMount(
    mountPath: string,
    volumeId: PortableFsVolumeId,
    enrollmentId: string,
    signal: AbortSignal,
  ): Promise<void> {
    // PortableFS immediately renews a new automatic mount. Observe that owner's
    // success rather than implement another renewer or accept a mount which will
    // inevitably expire because only Host can reach Manager.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), mountRenewalReadinessMs);
    const bounded = AbortSignal.any([signal, deadline.signal]);
    try {
      while (true) {
        bounded.throwIfAborted();
        const inventory = await this.#portableFs.listMounts({ signal: bounded });
        const row = inventory.mounts.find(
          (candidate) => resolve(candidate.mountPath) === mountPath,
        );
        if (
          !row ||
          row.volumeId !== volumeId ||
          !row.alive ||
          row.health !== "live" ||
          row.mountEnrollmentId !== enrollmentId
        ) {
          throw new Error("PortableFS did not report the expected live Workspace mount");
        }
        if ((row.lastReauthorizationAtMs ?? 0) > 0) return;
        await delay(100, undefined, { signal: bounded });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.signal.aborted) throw error;
      throw new Error(
        "PortableFS could not verify automatic mount renewal. The Runner must be able to reach the configured Manager HTTPS endpoint with its enrollment credentials.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #cleanupMountCreatedHere(input: {
    readonly enrollmentId: string | undefined;
    readonly mountPath: string;
    readonly mountReturned: boolean;
    readonly volumeId: PortableFsVolumeId;
  }): Promise<unknown | undefined> {
    try {
      if (!input.mountReturned) return undefined;
      const inventory = await this.#portableFs.listMounts();
      const row = inventory.mounts.find(
        (candidate) => resolve(candidate.mountPath) === input.mountPath,
      );
      if (!row) return undefined;
      if (
        row.volumeId !== input.volumeId ||
        !input.enrollmentId ||
        row.mountEnrollmentId !== input.enrollmentId
      ) {
        throw new Error(
          "Refusing to detach a PortableFS mount that was not created by this mount operation",
        );
      }
      const result = await this.#portableFs.unmount({ mountPath: input.mountPath });
      if (resolve(result.mountPath) !== input.mountPath) {
        throw new Error("PortableFS reported unmounting a different path");
      }
      const after = await this.#portableFs.listMounts();
      if (after.mounts.some((candidate) => resolve(candidate.mountPath) === input.mountPath)) {
        throw new Error("PortableFS Workspace mount remains present after failed mount cleanup");
      }
      return undefined;
    } catch (error) {
      return error;
    }
  }

  async #exchangeGrant(
    plan: PortableFsWorkspaceExecutionAccessPlan,
    requestInput: unknown,
    signal: AbortSignal,
  ) {
    const request = MountGrantExchangeRequestSchema.parse(requestInput);
    const requestBody = JSON.stringify(request);
    const deadline = Date.now() + MOUNT_EXCHANGE_RETRY_WINDOW_MS;
    let retryDelayMs = MOUNT_EXCHANGE_INITIAL_RETRY_MS;
    while (true) {
      let response: Response;
      let body: string;
      const requestAbort = new AbortController();
      const remainingMs = Math.max(1, deadline - Date.now());
      try {
        ({ body, response } = await withTimeout(
          this.#fetchExchangeResponse(
            plan,
            requestBody,
            AbortSignal.any([signal, requestAbort.signal]),
          ),
          remainingMs,
          {
            signal,
            timeoutError: () => new Error("Mount grant exchange timed out"),
          },
        ));
      } catch (error) {
        if (error instanceof MountExchangeResponseError) throw error;
        if (signal.aborted || !canRetryBefore(deadline, retryDelayMs)) {
          throw new Error("Mount grant exchange could not be reached", {
            cause: safeCause(error),
          });
        }
        await abortableDelay(retryDelayMs, signal);
        retryDelayMs = Math.min(retryDelayMs * 2, MOUNT_EXCHANGE_MAX_RETRY_MS);
        continue;
      } finally {
        requestAbort.abort();
      }
      if (!response.ok) {
        if (
          response.status === 503 &&
          isRetryableMountExchangeError(body) &&
          canRetryBefore(deadline, retryDelayMs)
        ) {
          await abortableDelay(retryDelayMs, signal);
          retryDelayMs = Math.min(retryDelayMs * 2, MOUNT_EXCHANGE_MAX_RETRY_MS);
          continue;
        }
        throw new Error(`Mount grant exchange failed with HTTP ${response.status}`);
      }
      if (body.length === 0) throw new Error("Mount grant exchange returned an empty response");
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch (error) {
        throw new Error("Mount grant exchange returned invalid JSON", { cause: error });
      }
      return MountGrantExchangeResponseSchema.parse(value);
    }
  }

  async #fetchExchangeResponse(
    plan: PortableFsWorkspaceExecutionAccessPlan,
    requestBody: string,
    signal: AbortSignal,
  ): Promise<{ readonly body: string; readonly response: Response }> {
    const response = await this.#fetch(plan.exchangeUrl, {
      body: requestBody,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${plan.exchangeToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal,
    });
    let body: string;
    try {
      body = await readBoundedText(response, {
        maximumBytes: MAX_EXCHANGE_RESPONSE_BYTES,
        sizeError: () =>
          new MountExchangeResponseError("Mount grant exchange response exceeded the size limit"),
      });
    } catch (error) {
      if (error instanceof MountExchangeResponseError) throw error;
      throw new MountExchangeResponseError("Mount grant exchange response could not be read", {
        cause: error,
      });
    }
    return { body, response };
  }

  async #withWorkspaceLock<T>(workspaceId: WorkspaceId, operation: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = prior.then(() => current);
    this.#locks.set(workspaceId, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(workspaceId) === tail) this.#locks.delete(workspaceId);
    }
  }
}

export class OpenSslMountIdentityIssuer implements MountIdentityIssuer {
  readonly #binary: string;

  constructor(binary = "openssl") {
    if (!binary.trim()) throw new TypeError("OpenSSL binary is required");
    this.#binary = binary;
  }

  async create(input: {
    readonly directory: string;
    readonly runnerId: RunnerId;
    readonly signal: AbortSignal;
  }): Promise<{ readonly csrPem: string; readonly privateKeyPath: string }> {
    const directory = resolve(input.directory);
    const privateKeyPath = join(directory, "client-private-key.pem");
    const csrPath = join(directory, "client-certificate-request.pem");
    await runBoundedProcess({
      args: [
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        privateKeyPath,
        "-out",
        csrPath,
        "-subj",
        `/CN=opensteer-${input.runnerId}`,
      ],
      cwd: directory,
      executable: this.#binary,
      signal: input.signal,
    });
    await setPrivateFileMode(privateKeyPath);
    await setPrivateFileMode(csrPath);
    const csrPem = await readFile(csrPath, "utf8");
    if (
      Buffer.byteLength(csrPem, "utf8") > MAX_CSR_BYTES ||
      !csrPem.includes("-----BEGIN CERTIFICATE REQUEST-----")
    ) {
      throw new Error("OpenSSL produced an invalid certificate request");
    }
    return { csrPem, privateKeyPath };
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await setPrivateFileMode(path);
}

function assertAutomaticManagerEndpoint(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("Automatic PortableFS renewal requires an origin-only HTTPS Manager URL");
  }
}

function validateExchangeUrl(url: URL, mode: RuntimeMode): void {
  if (url.username || url.password || url.hash) {
    throw new Error("Mount grant exchange URL must not contain credentials or a fragment");
  }
  if (url.protocol === "https:") return;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    url.protocol === "http:" &&
    (hostname === "localhost" ||
      hostname === "::1" ||
      (isIP(hostname) === 4 && hostname.split(".")[0] === "127"));
  if (mode !== "production" && loopback) return;
  throw new Error("Mount grant exchange URL must use HTTPS");
}

function canRetryBefore(deadline: number, delayMs: number): boolean {
  return Date.now() + delayMs < deadline;
}

function isRetryableMountExchangeError(body: string): boolean {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || !("error" in value)) return false;
    const error = value.error;
    return (
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "workspace_unavailable" &&
      "retryable" in error &&
      error.retryable === true
    );
  } catch {
    return false;
  }
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("Mount grant exchange was aborted");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }, delayMs);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      rejectPromise(signal.reason ?? new Error("Mount grant exchange was aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function runBoundedProcess(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executable: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: {
        HOME: input.cwd,
        LANG: "C",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    timeout.unref();
    const abort = () => child.kill("SIGKILL");
    input.signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes <= 64 * 1_024) stderr.push(value);
      else child.kill("SIGKILL");
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (input.signal.aborted) {
          reject(input.signal.reason ?? new Error("Operation aborted"));
        } else if (code === 0) {
          resolvePromise();
        } else {
          const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000);
          reject(
            new Error(
              `OpenSSL certificate request failed (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
            ),
          );
        }
      });
    });

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      callback();
    }
  });
}

function assertPathWithin(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (!path || path.startsWith("..") || isAbsolute(path)) {
    throw new Error("Runner path escaped its assigned Workspace root");
  }
}

function isPathWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return Boolean(path) && !path.startsWith("..") && !isAbsolute(path);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isPathWithin(left, right) || isPathWithin(right, left);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : "unknown failure";
}

function safeCause(error: unknown): Error {
  return error instanceof Error ? new Error(error.message) : new Error("Network request failed");
}
