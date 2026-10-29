import { createHash, randomUUID } from "node:crypto";
import { OpensteerError, type PortableFsWorkspaceBacking, type Workspace } from "@opensteer/core";
import {
  WorkspaceDirectoryPageSchema,
  WorkspaceFileEntrySchema,
  WorkspaceFilePreviewMetadataSchema,
  workspaceDirectoryPageMaxEntries,
  workspaceFilePreviewMaxBytes,
  type WorkspaceDirectoryPage,
  type WorkspaceFilePreviewMetadata,
} from "@opensteer/protocol";
import {
  type IssuePortableFsReadSessionGrantInput,
  type PortableFsManagerClient,
} from "@opensteer/workspace-portablefs";
import { readBoundedJson, readBoundedResponse } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import type { SignedTokenService } from "../../identity/host-keys.js";
import type {
  WorkspaceFileListInput,
  WorkspaceFilePreview,
  WorkspaceFilesDriver,
} from "./workspace-files-types.js";

const gatewayRequestTimeoutMs = 30_000;
const sessionFreshnessMs = 45_000;
const sessionStatusCacheMs = 15_000;
const grantLifetimeSeconds = 10 * 60;
// Covers one schema-maximal 500-entry page while keeping gateway allocation bounded.
const maximumGatewayJsonBytes = 8 * 1_024 * 1_024;

const GatewayIdentitySchema = z.strictObject({
  csrPem: z.string().includes("-----BEGIN CERTIFICATE REQUEST-----").max(32_768),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const GatewaySessionStatusSchema = z
  .strictObject({
    authorityGeneration: z.number().int().positive().optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    managerReleaseId: z.string().min(1).max(256).optional(),
    ready: z.boolean(),
  })
  .refine((value) => !value.ready || value.expiresAt !== undefined);
const GatewaySessionInstallSchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }),
  ready: z.literal(true),
});
const GatewayErrorSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
});
const GatewayWorkspaceFileEntrySchema = WorkspaceFileEntrySchema.extend({
  /** PortableFS needs raw Linux filename bytes internally; they never cross the product API. */
  nameBytes: z
    .string()
    .max(340)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const GatewayWorkspaceDirectoryPageSchema = WorkspaceDirectoryPageSchema.extend({
  entries: z.array(GatewayWorkspaceFileEntrySchema).max(workspaceDirectoryPageMaxEntries),
});

interface CachedSession {
  readonly checkedAt: number;
  readonly expiresAt: number;
}

type PortableFsWorkspace = Workspace & { readonly backing: PortableFsWorkspaceBacking };

export class PortableFsWorkspaceFilesDriver implements WorkspaceFilesDriver<PortableFsWorkspace> {
  readonly kind = "portablefs" as const;
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #manager: Pick<PortableFsManagerClient, "getVolume" | "issueReadSessionGrant">;
  readonly #archiveSummaries = new Map<
    string,
    { readonly attempt: string; readonly fetchedAt: number; readonly sealedEpoch: number }
  >();
  readonly #tokens: Pick<SignedTokenService, "issue">;
  readonly #sessions = new Map<string, CachedSession>();
  readonly #sessionLoads = new Map<string, Promise<void>>();
  readonly #identityLoads = new Map<string, Promise<z.infer<typeof GatewayIdentitySchema>>>();

  constructor(options: {
    readonly baseUrl: string | URL;
    readonly fetchImplementation?: typeof globalThis.fetch;
    readonly manager: Pick<PortableFsManagerClient, "getVolume" | "issueReadSessionGrant">;
    readonly tokens: Pick<SignedTokenService, "issue">;
  }) {
    this.#baseUrl = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(this.#baseUrl.protocol) ||
      this.#baseUrl.username ||
      this.#baseUrl.password ||
      this.#baseUrl.pathname !== "/" ||
      this.#baseUrl.search ||
      this.#baseUrl.hash
    ) {
      throw new TypeError("Files service URL must be an HTTP(S) origin");
    }
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#manager = options.manager;
    this.#tokens = options.tokens;
  }

  async list(
    workspace: PortableFsWorkspace,
    input: WorkspaceFileListInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryPage> {
    const query = new URLSearchParams({ limit: String(input.limit), parent: input.parentKey });
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.knownRevision) query.set("revision", input.knownRevision);
    if (input.retainedCursor) query.set("retain", input.retainedCursor);
    const archivedClaims = await this.#archivedClaims(workspace, signal);
    const response = await this.#withSession(
      workspace,
      () =>
        this.#gatewayRequest(
          `/v1/volumes/${encodeURIComponent(workspace.backing.volumeId)}/entries?${query}`,
          {
            claims: {
              cursor: input.cursor ?? "",
              knownRevision: input.knownRevision ?? "",
              limit: input.limit,
              operation: "list",
              pathKey: input.parentKey,
              retainedCursor: input.retainedCursor ?? "",
              volumeId: workspace.backing.volumeId,
            },
            ...archivedClaims,
            ...(signal ? { signal } : {}),
          },
        ),
      signal,
    );
    const gatewayPage = GatewayWorkspaceDirectoryPageSchema.parse(await readGatewayJson(response));
    return WorkspaceDirectoryPageSchema.parse({
      ...gatewayPage,
      entries: gatewayPage.entries.map(({ nameBytes: _privateNameBytes, ...entry }) => entry),
    });
  }

  async preview(
    workspace: PortableFsWorkspace,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePreview> {
    const query = new URLSearchParams({
      file: fileKey,
      length: String(workspaceFilePreviewMaxBytes),
      mode: "preview",
      offset: "0",
    });
    const archivedClaims = await this.#archivedClaims(workspace, signal);
    const response = await this.#withSession(
      workspace,
      () =>
        this.#gatewayRequest(
          `/v1/volumes/${encodeURIComponent(workspace.backing.volumeId)}/content?${query}`,
          {
            claims: {
              length: workspaceFilePreviewMaxBytes,
              operation: "preview",
              pathKey: fileKey,
              volumeId: workspace.backing.volumeId,
            },
            ...archivedClaims,
            ...(signal ? { signal } : {}),
          },
        ),
      signal,
    );
    const bytes = await readBoundedResponse(response, {
      maximumBytes: workspaceFilePreviewMaxBytes,
      sizeError: () => unavailable("Files service exceeded the preview byte bound"),
    });
    return {
      bytes,
      metadata: previewMetadata(response),
    };
  }

  async download(
    workspace: PortableFsWorkspace,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const query = new URLSearchParams({
      file: fileKey,
      length: "0",
      mode: "download",
      offset: "0",
    });
    const archivedClaims = await this.#archivedClaims(workspace, signal);
    return this.#withSession(
      workspace,
      () =>
        this.#gatewayRequest(
          `/v1/volumes/${encodeURIComponent(workspace.backing.volumeId)}/content?${query}`,
          {
            claims: {
              operation: "download",
              pathKey: fileKey,
              volumeId: workspace.backing.volumeId,
            },
            ...archivedClaims,
            ...(signal ? { signal } : {}),
            timeoutMs: 15 * 60 * 1_000,
          },
        ),
      signal,
    );
  }

  /**
   * Evicts the gateway's live read session for a volume and records a fence
   * floor, so a pre-quiesce grant cannot re-install a session behind the
   * archive cycle. Defense in depth: the authority stop kills any surviving
   * session anyway, so a gateway outage here is logged by the caller and
   * never blocks the archive.
   */
  async evictSession(workspace: PortableFsWorkspace, signal?: AbortSignal): Promise<void> {
    const volumeId = workspace.backing.volumeId;
    const response = await this.#gatewayRequest(
      `/v1/volumes/${encodeURIComponent(volumeId)}/session`,
      {
        claims: {
          fence: workspace.backing.generation,
          operation: "session.delete",
          volumeId,
        },
        method: "DELETE",
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw unavailable("Files service could not evict the Workspace read session");
    }
    this.#sessions.delete(volumeId);
  }

  /**
   * Archived reads carry the sealed archive's identity as signed claims: the
   * gateway derives object keys from its own root-pinned prefix plus these
   * identities, so no key or credential ever crosses this boundary. The
   * summary is immutable per archive cycle; a short cache keeps volume polls
   * off the hot path.
   */
  async #archivedClaims(
    workspace: PortableFsWorkspace,
    signal?: AbortSignal,
  ): Promise<{ archived: true; attempt: string; sealedEpoch: number } | Record<string, never>> {
    assertReadableWorkspace(workspace);
    if (workspace.status !== "archived") return {};
    const volumeId = workspace.backing.volumeId;
    const cached = this.#archiveSummaries.get(volumeId);
    if (cached && Date.now() - cached.fetchedAt < 60_000) {
      return { archived: true, attempt: cached.attempt, sealedEpoch: cached.sealedEpoch };
    }
    const volume = await this.#manager.getVolume(volumeId, signal ? { signal } : {});
    const summary = volume.archive_summary;
    if (!summary) {
      throw unavailable("The archived Workspace volume has no sealed archive to read");
    }
    this.#archiveSummaries.set(volumeId, {
      attempt: summary.attempt,
      fetchedAt: Date.now(),
      sealedEpoch: summary.sealed_epoch,
    });
    return { archived: true, attempt: summary.attempt, sealedEpoch: summary.sealed_epoch };
  }

  async #withSession(
    workspace: PortableFsWorkspace,
    operation: () => Promise<Response>,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (workspace.status === "archived") return operation();
    await this.#ensureSession(workspace, false, signal);
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof FilesGatewayError) || error.code !== "session_required") throw error;
      this.#sessions.delete(workspace.backing.volumeId);
      await this.#ensureSession(workspace, true, signal);
      try {
        return await operation();
      } catch (retryError) {
        if (retryError instanceof FilesGatewayError && retryError.code === "session_required") {
          this.#sessions.delete(workspace.backing.volumeId);
          throw unavailable(
            "Files service could not retain the Workspace read session",
            retryError,
          );
        }
        throw retryError;
      }
    }
  }

  async #ensureSession(
    workspace: PortableFsWorkspace,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (workspace.status !== "ready" && workspace.status !== "archived") {
      throw unavailable(workspace.storageIssue?.message ?? "Workspace storage is not ready");
    }
    const now = Date.now();
    const cached = this.#sessions.get(workspace.backing.volumeId);
    if (
      !force &&
      cached &&
      now - cached.checkedAt < sessionStatusCacheMs &&
      cached.expiresAt > now + sessionFreshnessMs
    ) {
      return;
    }
    const existing = this.#sessionLoads.get(workspace.backing.volumeId);
    if (existing) return abortable(existing, signal);
    const load = this.#loadSession(workspace, force).finally(() => {
      if (this.#sessionLoads.get(workspace.backing.volumeId) === load) {
        this.#sessionLoads.delete(workspace.backing.volumeId);
      }
    });
    this.#sessionLoads.set(workspace.backing.volumeId, load);
    return abortable(load, signal);
  }

  async #loadSession(workspace: PortableFsWorkspace, force: boolean): Promise<void> {
    if (!force) {
      const statusResponse = await this.#gatewayRequest(
        `/v1/volumes/${encodeURIComponent(workspace.backing.volumeId)}/session`,
        {
          claims: { operation: "session.status", volumeId: workspace.backing.volumeId },
        },
      );
      const status = GatewaySessionStatusSchema.parse(await readGatewayJson(statusResponse));
      const expiresAt = status.expiresAt ? Date.parse(status.expiresAt) : 0;
      if (status.ready && expiresAt > Date.now() + sessionFreshnessMs) {
        this.#sessions.set(workspace.backing.volumeId, {
          checkedAt: Date.now(),
          expiresAt,
        });
        return;
      }
    }
    const identity = await this.#loadIdentity(workspace.backing.volumeId);
    const grantId = randomUUID();
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const grantInput: IssuePortableFsReadSessionGrantInput = {
      authorization: {
        expiresUnix: nowSeconds + grantLifetimeSeconds,
        nonce: grantId,
        notBeforeUnix: Math.max(0, nowSeconds - 5),
      },
      clientCertificateRequestPem: identity.csrPem,
      owner: workspace.createdBy,
      subject: `opensteer-files:${identity.keyId}`,
    };
    const grant = await this.#manager.issueReadSessionGrant(
      workspace.backing.volumeId,
      grantInput,
      {
        idempotencyKey: `files:${workspace.backing.volumeId}:${grantId}`,
      },
    );
    const grantBody = JSON.stringify(grant);
    const installedResponse = await this.#gatewayRequest(
      `/v1/volumes/${encodeURIComponent(workspace.backing.volumeId)}/session`,
      {
        body: grantBody,
        claims: {
          bodySha256: createHash("sha256").update(grantBody).digest("base64url"),
          // The install carries the storage lifecycle generation as its fence,
          // so the gateway can reject a session whose grant predates an archive
          // initiation (which bumps the generation and records it as the floor).
          fence: workspace.backing.generation,
          operation: "session.install",
          volumeId: workspace.backing.volumeId,
        },
        method: "PUT",
      },
    );
    const installed = GatewaySessionInstallSchema.parse(await readGatewayJson(installedResponse));
    this.#sessions.set(workspace.backing.volumeId, {
      checkedAt: Date.now(),
      expiresAt: Date.parse(installed.expiresAt),
    });
  }

  async #loadIdentity(volumeId: string): Promise<z.infer<typeof GatewayIdentitySchema>> {
    const existing = this.#identityLoads.get(volumeId);
    if (existing) return existing;
    const load = (async () => {
      const response = await this.#gatewayRequest(
        `/v1/volumes/${encodeURIComponent(volumeId)}/identity`,
        {
          claims: { operation: "identity", volumeId },
        },
      );
      return GatewayIdentitySchema.parse(await readGatewayJson(response));
    })().finally(() => {
      if (this.#identityLoads.get(volumeId) === load) this.#identityLoads.delete(volumeId);
    });
    this.#identityLoads.set(volumeId, load);
    return load;
  }

  async #gatewayRequest(
    path: string,
    options: {
      readonly archived?: boolean;
      readonly attempt?: string;
      readonly body?: string;
      readonly claims: Readonly<Record<string, unknown>>;
      readonly method?: "DELETE" | "GET" | "PUT";
      readonly sealedEpoch?: number;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<Response> {
    const headers = new Headers({
      accept: "application/json, application/octet-stream",
      authorization: `Bearer ${this.#tokens.issue(
        {
          ...options.claims,
          ...(options.archived
            ? { archived: true, attempt: options.attempt, sealedEpoch: options.sealedEpoch }
            : {}),
          aud: "portablefs-files",
        },
        30,
      )}`,
    });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        ...(options.body !== undefined ? { body: options.body } : {}),
        headers,
        method: options.method ?? "GET",
        redirect: "manual",
        signal: requestSignal(options.signal, options.timeoutMs ?? gatewayRequestTimeoutMs),
      });
    } catch (error) {
      throw unavailable("Files service is unavailable", error);
    }
    if (response.ok) return response;
    let parsed: z.infer<typeof GatewayErrorSchema> | undefined;
    try {
      parsed = GatewayErrorSchema.parse(await readGatewayJson(response));
    } catch {
      // A bounded, typed error below deliberately hides upstream internals.
    }
    const gatewayError = new FilesGatewayError(
      parsed?.error.code ?? "gateway_error",
      parsed?.error.message ?? `Files service returned HTTP ${response.status}`,
      response.status,
    );
    if (gatewayError.code === "session_required") throw gatewayError;
    throw translateGatewayError(gatewayError);
  }
}

class FilesGatewayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "FilesGatewayError";
    this.code = code;
    this.status = status;
  }
}

async function readGatewayJson(response: Response): Promise<unknown> {
  return readBoundedJson(response, {
    emptyValue: {},
    fatalUtf8: false,
    invalidJsonError: (cause) => unavailable("Files service returned invalid JSON", cause),
    maximumBytes: maximumGatewayJsonBytes,
    sizeError: () => unavailable("Files service JSON response exceeded its byte bound"),
  });
}

function previewMetadata(response: Response): WorkspaceFilePreviewMetadata {
  const sizeBytes = Number(response.headers.get("x-opensteer-file-size"));
  const lastModified = response.headers.get("last-modified");
  return WorkspaceFilePreviewMetadataSchema.parse({
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    etag: response.headers.get("etag") ?? "missing",
    modifiedAt: lastModified ? new Date(lastModified).toISOString() : null,
    sizeBytes,
    truncated: response.headers.get("x-opensteer-file-truncated") === "true",
  });
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortable<Value>(operation: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (!signal) return operation;
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

function unavailable(message: string, cause?: unknown): OpensteerError {
  return new OpensteerError({ cause, code: "workspace_unavailable", message, retryable: true });
}

/**
 * A Workspace whose archive cycle is still running has neither a servable
 * filesystem nor a sealed archive. Its read session was evicted when the
 * archive was claimed and the storage authority may already be stopping, so a
 * session install would be a request the gateway is right to reject; and there
 * is no sealed archive identity to sign archived claims with yet. The cycle is
 * cancellable — using the Workspace wakes it — so this is retryable.
 */
function assertReadableWorkspace(workspace: PortableFsWorkspace): void {
  if (workspace.status === "archiving") {
    throw unavailable("This Workspace is being archived; it is readable again once it wakes");
  }
}

function translateGatewayError(error: FilesGatewayError): OpensteerError {
  switch (error.code) {
    case "not_found":
      return new OpensteerError({ code: "not_found", message: "File not found" });
    case "invalid_path":
    case "invalid_range":
    case "invalid_request":
      return new OpensteerError({ code: "bad_request", message: error.message });
    case "cursor_expired":
    case "directory_changed":
      return new OpensteerError({
        code: "conflict",
        message: error.message,
        retryable: true,
      });
    case "timeout":
      return new OpensteerError({ code: "timeout", message: error.message, retryable: true });
    default:
      return unavailable("Workspace files are temporarily unavailable", error);
  }
}
