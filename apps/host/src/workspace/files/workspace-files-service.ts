import {
  OpensteerError,
  type LocalWorkspaceBacking,
  type PortableFsWorkspaceBacking,
  type Workspace,
} from "@opensteer/core";
import type {
  OpensteerStore,
  WorkspaceFilesAdmission,
  WorkspaceMembershipRecord,
} from "@opensteer/database";
import type { WorkspaceDirectoryPage } from "@opensteer/protocol";
import type { RunnerLocalWorkspaceFilesDriver } from "./workspace-files-runner-local-driver.js";
import type { PortableFsWorkspaceFilesDriver } from "./workspace-files-portablefs-driver.js";
import type { WorkspaceFileListInput, WorkspaceFilePreview } from "./workspace-files-types.js";
import type { WorkspaceActivityService } from "../workspace-activity.js";

const membershipRevalidationByteInterval = 1 * 1_024 * 1_024;
const membershipRevalidationTimeIntervalMs = 250;
const maximumDownloadEmissionBytes = 64 * 1_024;

type WorkspaceMembershipRepository = Pick<
  OpensteerStore,
  "onWorkspaceMembershipChanged" | "workspaceMembershipForUser"
>;

/**
 * Product-facing Files router. A Deployment registers a reader for each kind of
 * storage it holds — shared volumes here, and every lent machine's own
 * directories through the Runner that owns them.
 */
export class WorkspaceFilesService {
  readonly #activeMemberships = new Map<string, Set<WorkspaceFilesLease>>();
  readonly #activity: Pick<WorkspaceActivityService, "note"> | undefined;
  readonly #local: RunnerLocalWorkspaceFilesDriver | undefined;
  readonly #memberships: WorkspaceMembershipRepository;
  readonly #portableFs: PortableFsWorkspaceFilesDriver | undefined;
  readonly #unsubscribeMembershipChanges: () => void;

  constructor(options: {
    readonly activity?: Pick<WorkspaceActivityService, "note">;
    readonly local?: RunnerLocalWorkspaceFilesDriver;
    readonly memberships: WorkspaceMembershipRepository;
    readonly portableFs?: PortableFsWorkspaceFilesDriver;
  }) {
    if (options.local === undefined && options.portableFs === undefined) {
      throw new TypeError("Workspace Files requires at least one backing driver");
    }
    this.#activity = options.activity;
    this.#local = options.local;
    this.#memberships = options.memberships;
    this.#portableFs = options.portableFs;
    this.#unsubscribeMembershipChanges = options.memberships.onWorkspaceMembershipChanged(
      (membership) => this.#membershipChanged(membership),
    );
  }

  async list(
    admission: WorkspaceFilesAdmission,
    input: WorkspaceFileListInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryPage> {
    this.#activity?.note(admission.workspace.id);
    return this.#withLease(admission, signal, (operationSignal) => {
      const { workspace } = admission;
      switch (workspace.backing.kind) {
        case "local-directory":
          return this.#requiredLocal().list(asLocalWorkspace(workspace), input, operationSignal);
        case "portablefs":
          return this.#requiredPortableFs().list(
            asPortableFsWorkspace(workspace),
            input,
            operationSignal,
          );
      }
    });
  }

  async preview(
    admission: WorkspaceFilesAdmission,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePreview> {
    this.#activity?.note(admission.workspace.id);
    return this.#withLease(admission, signal, (operationSignal) => {
      const { workspace } = admission;
      switch (workspace.backing.kind) {
        case "local-directory":
          return this.#requiredLocal().preview(
            asLocalWorkspace(workspace),
            fileKey,
            operationSignal,
          );
        case "portablefs":
          return this.#requiredPortableFs().preview(
            asPortableFsWorkspace(workspace),
            fileKey,
            operationSignal,
          );
      }
    });
  }

  async download(
    admission: WorkspaceFilesAdmission,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    this.#activity?.note(admission.workspace.id);
    const lease = await this.#openLease(admission, signal);
    try {
      const { workspace } = admission;
      const response = await abortable(
        workspace.backing.kind === "local-directory"
          ? this.#requiredLocal().download(asLocalWorkspace(workspace), fileKey, lease.signal)
          : this.#requiredPortableFs().download(
              asPortableFsWorkspace(workspace),
              fileKey,
              lease.signal,
            ),
        lease.signal,
      );
      await lease.revalidate();
      if (!response.body) {
        lease.close();
        return response;
      }
      return new Response(membershipFencedStream(response.body, lease), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (error) {
      lease.close();
      throw error;
    }
  }

  close(): void {
    this.#unsubscribeMembershipChanges();
    for (const leases of this.#activeMemberships.values()) {
      for (const lease of leases) lease.abort(new Error("Workspace Files service closed"));
    }
    this.#activeMemberships.clear();
  }

  async #openLease(
    admission: WorkspaceFilesAdmission,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesLease> {
    const scope = membershipScope(admission.workspace.id, admission.userId);
    const leases = this.#activeMemberships.get(scope) ?? new Set<WorkspaceFilesLease>();
    this.#activeMemberships.set(scope, leases);
    let lease!: WorkspaceFilesLease;
    lease = new WorkspaceFilesLease({
      admission,
      memberships: this.#memberships,
      onClose: () => {
        leases.delete(lease);
        if (leases.size === 0) this.#activeMemberships.delete(scope);
      },
      ...(signal ? { signal } : {}),
    });
    leases.add(lease);
    try {
      // Closes the admission/register race: a membership change that committed
      // before the lease entered the registry is caught here.
      await lease.revalidate();
      return lease;
    } catch (error) {
      lease.close();
      throw error;
    }
  }

  async #withLease<Result>(
    admission: WorkspaceFilesAdmission,
    signal: AbortSignal | undefined,
    operation: (operationSignal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const lease = await this.#openLease(admission, signal);
    try {
      const result = await abortable(operation(lease.signal), lease.signal);
      // Drivers must receive the abort signal, but the post-operation check
      // also fences an implementation that completed concurrently with revoke.
      await lease.revalidate();
      return result;
    } finally {
      lease.close();
    }
  }

  #membershipChanged(membership: WorkspaceMembershipRecord): void {
    const leases = this.#activeMemberships.get(
      membershipScope(membership.workspaceId, membership.userId),
    );
    if (!leases) return;
    for (const lease of leases) {
      if (membership.state !== "active" || membership.generation !== lease.generation) {
        lease.abort(membershipChangedError());
      }
    }
  }

  #requiredLocal(): RunnerLocalWorkspaceFilesDriver {
    if (this.#local !== undefined) return this.#local;
    throw unsupportedBacking("local-directory");
  }

  #requiredPortableFs(): PortableFsWorkspaceFilesDriver {
    if (this.#portableFs !== undefined) return this.#portableFs;
    throw unsupportedBacking("portablefs");
  }
}

class WorkspaceFilesLease {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly #admission: WorkspaceFilesAdmission;
  readonly #controller = new AbortController();
  readonly #memberships: WorkspaceMembershipRepository;
  readonly #onClose: () => void;
  #closed = false;
  #lastRevalidatedAt = 0;
  #bytesSinceRevalidation = 0;

  constructor(options: {
    readonly admission: WorkspaceFilesAdmission;
    readonly memberships: WorkspaceMembershipRepository;
    readonly onClose: () => void;
    readonly signal?: AbortSignal;
  }) {
    this.#admission = options.admission;
    this.generation = options.admission.membershipGeneration;
    this.#memberships = options.memberships;
    this.#onClose = options.onClose;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.#controller.signal])
      : this.#controller.signal;
  }

  abort(reason: unknown): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }

  assertLive(): void {
    this.signal.throwIfAborted();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
  }

  async revalidate(): Promise<void> {
    this.assertLive();
    const membership = await this.#memberships.workspaceMembershipForUser(
      this.#admission.workspace.id,
      this.#admission.userId,
    );
    if (!membership || membership.state !== "active" || membership.generation !== this.generation) {
      const error = membershipChangedError();
      this.abort(error);
      throw error;
    }
    this.assertLive();
    this.#bytesSinceRevalidation = 0;
    this.#lastRevalidatedAt = Date.now();
  }

  async revalidateStream(nextBytes: number): Promise<void> {
    this.assertLive();
    this.#bytesSinceRevalidation += nextBytes;
    if (
      this.#bytesSinceRevalidation >= membershipRevalidationByteInterval ||
      Date.now() - this.#lastRevalidatedAt >= membershipRevalidationTimeIntervalMs
    ) {
      await this.revalidate();
    }
    this.assertLive();
  }
}

function membershipFencedStream(
  upstream: ReadableStream<Uint8Array>,
  lease: WorkspaceFilesLease,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let pending: Uint8Array | undefined;

  return new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        lease.close();
        await reader.cancel(reason).catch(() => undefined);
      },
      async pull(controller) {
        try {
          lease.assertLive();
          if (!pending || pending.byteLength === 0) {
            const result = await abortable(reader.read(), lease.signal);
            lease.assertLive();
            if (result.done) {
              lease.close();
              controller.close();
              return;
            }
            pending = result.value;
          }
          const next = pending.subarray(0, maximumDownloadEmissionBytes);
          await lease.revalidateStream(next.byteLength);
          pending =
            pending.byteLength === next.byteLength ? undefined : pending.subarray(next.length);
          controller.enqueue(next);
        } catch (error) {
          lease.close();
          controller.error(error);
          void reader.cancel(error).catch(() => undefined);
        }
      },
    },
    // Do not authorize/prefetch another chunk after satisfying a consumer
    // read. Every pull must correspond to downstream demand.
    { highWaterMark: 0 },
  );
}

function membershipScope(
  workspaceId: Workspace["id"],
  userId: WorkspaceFilesAdmission["userId"],
): string {
  return `${workspaceId}\u0000${userId}`;
}

function membershipChangedError(): OpensteerError {
  return new OpensteerError({ code: "not_found", message: "Workspace not found" });
}

function abortable<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  const abortReason = () => signal.reason ?? new DOMException("Aborted", "AbortError");
  if (signal.aborted) return Promise.reject(abortReason());
  return new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(abortReason());
    signal.addEventListener("abort", aborted, { once: true });
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

type LocalWorkspace = Workspace & { readonly backing: LocalWorkspaceBacking };
type PortableFsWorkspace = Workspace & { readonly backing: PortableFsWorkspaceBacking };

function asLocalWorkspace(workspace: Workspace): LocalWorkspace {
  if (workspace.backing.kind !== "local-directory")
    throw unsupportedBacking(workspace.backing.kind);
  return workspace as LocalWorkspace;
}

function asPortableFsWorkspace(workspace: Workspace): PortableFsWorkspace {
  if (workspace.backing.kind !== "portablefs") throw unsupportedBacking(workspace.backing.kind);
  return workspace as PortableFsWorkspace;
}

function unsupportedBacking(kind: Workspace["backing"]["kind"]): OpensteerError {
  return new OpensteerError({
    code: "workspace_unavailable",
    message: `This Host is not configured to read ${kind} Workspaces`,
  });
}

export { RunnerLocalWorkspaceFilesDriver } from "./workspace-files-runner-local-driver.js";
export { PortableFsWorkspaceFilesDriver } from "./workspace-files-portablefs-driver.js";
export type {
  WorkspaceFileListInput,
  WorkspaceFilePreview,
  WorkspaceFilesDriver,
} from "./workspace-files-types.js";
