import { BootstrapNoticeDiagnostics } from "@opensteer/shared/bootstrapDiagnostics";
import { forEachBoundedResponseChunk, readBoundedText } from "@opensteer/shared/boundedJson";
import { streamBoundedResponse } from "@opensteer/shared/responseStream";
import { ensurePrivateDirectory, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { openAsBlob, promises as fs } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentId } from "@opensteer/core";
import {
  hostApi,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
} from "@opensteer/protocol";
import type { HostSessionRecovery } from "@opensteer/client/auth";
import {
  HostTransport,
  HostTransportError,
  HostRouteUnavailableError,
  type DeploymentCatalogStore,
  type HostCredentialProvider,
  type HostNetwork,
  type HostNetworkSocket,
} from "@opensteer/client/connections";
import {
  DesktopCloseHostWebSocketInputSchema,
  DesktopDeploymentSelectionSchema,
  DesktopHostHttpRequestSchema,
  DesktopHostHttpResponseSchema,
  DesktopHostBinaryOpenInputSchema,
  DesktopHostBinaryOpenResultSchema,
  DesktopHostBinaryWriteInputSchema,
  DesktopHostBinaryTransferInputSchema,
  DesktopHostBinaryReadResultSchema,
  DesktopHostWebSocketCommandSchema,
  DesktopHostWebSocketEventSchema,
  DesktopOpenHostWebSocketInputSchema,
  DesktopOpenHostWebSocketResultSchema,
  DesktopSelectDeploymentInputSchema,
  DesktopSetDeploymentRouteInputSchema,
  type DesktopDeploymentSelection,
  type DesktopHostHttpResponse,
  type DesktopHostBinaryOpenInput,
  type DesktopHostWebSocketEvent,
} from "@opensteer/protocol/desktop";
import { desktopLocalHostRuntime, type DesktopAccessProjection } from "./access-projection.js";
import type { PersonalHostRuntimeSource } from "../supervisor/personal-host-runtime.js";
import {
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
  BrowserSessionIdSchema,
  type BrowserSessionId,
  type BrowserClientMessage,
  type BrowserServerMessage,
} from "@opensteer/protocol/browser";

export interface DesktopBrowserSocketObservation {
  readonly connectionId: string;
  readonly ownerId: number;
  readonly sessionId: BrowserSessionId;
  readonly mode: "control";
  readonly type: "admitted" | "closed";
}

export type DesktopBrowserControlObservation =
  | DesktopBrowserSocketObservation
  | (Omit<DesktopBrowserSocketObservation, "type"> &
      (
        | { readonly type: "message"; readonly message: BrowserServerMessage }
        | { readonly type: "presentation"; readonly surfaceId: string | null }
      ));

const maximumHostResponseBytes = 16 * 1_024 * 1_024;
const maximumBinaryBytes = 25 * 1_024 * 1_024;
const binaryChunkBytes = 256 * 1_024;
const maximumBinaryTransfers = 8;
const binaryIdleMilliseconds = 5 * 60_000;
// WHATWG WebSocket clients may send only normal closure or application codes.
const invalidHostFrameCloseCode = 4_002;
const consumerUnavailableCloseCode = 4_011;

type SocketEndInitiator =
  "network" | "renderer" | "deployment-changed" | "owner-gone" | "undeliverable";

interface OwnedSocket {
  readonly network: HostNetworkSocket;
  readonly transport: HostTransport;
  readonly ownerId: number;
  readonly end: (code: number, reason: string, initiator: SocketEndInitiator) => void;
  readonly passkeyConsumer: (surfaceId: string) => string | null;
  readonly viewerConsumer: (surfaceId: string) => string | null;
  readonly diagnoseTarget: (data: string | Uint8Array) => void;
}

interface BinaryTransfer {
  readonly transport: HostTransport;
  readonly ownerId: number;
  readonly attachmentKey: string;
  readonly directory: string;
  readonly path: string;
  readonly input: DesktopHostBinaryOpenInput;
  readonly controller: AbortController;
  readonly outcome: Promise<{
    readonly status: number;
    readonly contentType: string | null;
    readonly etag: string | null;
    readonly fileSizeBytes: number | null;
    readonly fileTruncated: boolean | null;
    readonly lastModified: string | null;
    readonly sizeBytes: number;
  }> | null;
  size: number;
  offset: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

type OutboundSocketEvent = DesktopHostWebSocketEvent extends infer Event
  ? Event extends { readonly connectionId: string }
    ? Omit<Event, "connectionId">
    : never
  : never;

/**
 * The Desktop's face of the shared transport: the Electron IPC envelopes, the
 * renderer that owns each socket, and the projection of the catalog that only
 * this application has, over the request, socket and fence ownership every
 * Opensteer client shares.
 *
 * Owner ids are `WebContents` ids. They are the whole reason this layer exists
 * rather than living in `@opensteer/client`: one main process serves several
 * renderers, so a socket belongs to exactly one of them and dies with it.
 */
export class DesktopHostTransport extends HostTransport {
  readonly #observeCommand:
    | ((
        deploymentId: DeploymentId,
        command: HostApiCommandInput,
        result: HostApiCommandOutput,
      ) => Promise<void>)
    | undefined;
  readonly #surfaceDiagnosticKey = randomBytes(32);
  readonly #log:
    ((event: string, fields: Record<string, string | number | boolean>) => void) | undefined;
  readonly #catalog: Pick<DeploymentCatalogStore, "load" | "select" | "setPreferredEndpoint">;
  readonly #teams = new Map<DeploymentId, HostTransport>();
  readonly #summaries = new Map<DeploymentId, HostTransport>();
  readonly #teamOptions: ConstructorParameters<typeof HostTransport>[0];
  readonly #unsubscribeCatalog: () => void;
  readonly #projection: Pick<DesktopAccessProjection, "read">;
  readonly #sockets = new Map<string, OwnedSocket>();
  readonly #binary = new Map<string, BinaryTransfer>();
  readonly #browserControlListeners = new Set<(event: DesktopBrowserControlObservation) => void>();
  readonly #browserSocketListeners = new Set<(event: DesktopBrowserSocketObservation) => void>();
  readonly #ownerGenerations = new Map<number, number>();
  readonly #socketGenerations = new WeakMap<HostTransport, number>();
  #openingBinary = 0;
  #selectedDeploymentId: DeploymentId | null = null;
  #disposed = false;
  readonly #bootstrapDiagnostics = new BootstrapNoticeDiagnostics();

  constructor(options: {
    readonly catalog: Pick<
      DeploymentCatalogStore,
      "load" | "select" | "setPreferredEndpoint" | "subscribe"
    >;
    readonly credentials?: HostCredentialProvider;
    readonly localRuntime: PersonalHostRuntimeSource;
    readonly network: HostNetwork;
    readonly log?: (event: string, fields: Record<string, string | number | boolean>) => void;
    readonly projection: Pick<DesktopAccessProjection, "read">;
    readonly sessions?: HostSessionRecovery;
    readonly observeCommand?: (
      deploymentId: DeploymentId,
      command: HostApiCommandInput,
      result: HostApiCommandOutput,
    ) => Promise<void>;
  }) {
    super({
      catalog: options.catalog,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      localRuntime: {
        current: async () => desktopLocalHostRuntime(await options.localRuntime.current()),
      },
      network: options.network,
      ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    });
    this.#observeCommand = options.observeCommand;
    this.#teamOptions = {
      catalog: options.catalog,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      localRuntime: {
        current: async () => desktopLocalHostRuntime(await options.localRuntime.current()),
      },
      network: options.network,
      ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
      expectedKind: "team",
    };
    this.#unsubscribeCatalog = options.catalog.subscribe(() => {
      for (const team of this.#teams.values()) void team.current().catch(() => undefined);
      for (const summary of this.#summaries.values()) void summary.current().catch(() => undefined);
    });
    this.#log = options.log;
    this.#catalog = options.catalog;
    this.#projection = options.projection;
  }

  /** Refreshes the attachment fence and republishes the catalog projection. */
  async selection(): Promise<DesktopDeploymentSelection> {
    try {
      await this.refreshSelection();
    } catch (error) {
      if (!(error instanceof HostRouteUnavailableError)) throw error;
      // The fence has released the old route; its absence is a place status,
      // not a failure to read the Account directory or publish other places.
    }
    const projection = await this.#projection.read();
    return DesktopDeploymentSelectionSchema.parse({
      deployments: projection.deployments.map(
        ({
          capabilities: _capabilities,
          accountAccess: _accountAccess,
          accountLivenessExpiresAt: _accountLivenessExpiresAt,
          hasAccountConnectRoute: _hasAccountConnectRoute,
          hasVerifiedAccountRoute: _hasVerifiedAccountRoute,
          key: _key,
          source: _source,
          ...summary
        }) => summary,
      ),
      revision: projection.revision,
      schemaVersion: 1,
      selectedDeploymentId: projection.selectedDeploymentId,
    });
  }

  async select(input: unknown): Promise<DesktopDeploymentSelection> {
    const parsed = DesktopSelectDeploymentInputSchema.parse(input);
    await this.#catalog.select(parsed.deploymentId);
    return this.selection();
  }

  async setRoute(input: unknown): Promise<DesktopDeploymentSelection> {
    const parsed = DesktopSetDeploymentRouteInputSchema.parse(input);
    await this.#catalog.setPreferredEndpoint(parsed);
    return this.selection();
  }

  /**
   * One renderer request, as the IPC envelope carries it. The whole body
   * crosses the bridge as a string, so it is read under a bound here rather
   * than streamed.
   */
  async request(input: unknown): Promise<DesktopHostHttpResponse> {
    const request = DesktopHostHttpRequestSchema.parse(input);
    if (request.path.split("?")[0] === "/v1/rpc/bootstrap.get") {
      const diagnostic = this.#bootstrapDiagnostics.report(request.headers.bootstrapDiagnostics);
      if (diagnostic) {
        try {
          this.#log?.("host.bootstrap.loop", {
            windowMs: diagnostic.windowMs,
            triggers: diagnostic.triggers,
            starts: diagnostic.starts,
          });
        } catch {
          /* Diagnostics cannot prevent a read. */
        }
      }
    }
    const path = request.path.split("?")[0];
    const summary =
      (path === "/v1/rpc/attention.get" && request.method === "POST") ||
      (path === "/v1/rpc/teams.links.list" && request.method === "POST");
    const transport = await this.#transport(request.expectedDeploymentId, summary);
    const observing =
      this.#observeCommand &&
      path === "/v1/rpc/commands.dispatch" &&
      typeof request.body === "string" &&
      (request.body.includes("machine.session.bind") ||
        request.body.includes("runner.enrollment.createLocal"));
    const selected = observing ? await transport.current() : null;
    const fencedRequest = selected
      ? {
          ...request,
          expectedDeploymentId: selected.resolved.deploymentId,
          expectedAttachmentKey: selected.resolved.key,
        }
      : request;
    const result = await transport.exchange(fencedRequest, async (response, progress) =>
      DesktopHostHttpResponseSchema.parse({
        body: await readBoundedText(response, {
          ...progress,
          fatalUtf8: true,
          invalidContentLengthError: () =>
            new Error("The Host returned an invalid content length."),
          maximumBytes: summary ? 512 * 1024 : maximumHostResponseBytes,
          sizeError: () => new HostTransportError("response-too-large"),
        }),
        headers: { contentType: response.headers.get("content-type") },
        status: response.status,
      }),
    );
    if (
      selected &&
      this.#observeCommand &&
      result.status === 200 &&
      typeof request.body === "string" &&
      (request.body.includes("machine.session.bind") ||
        request.body.includes("runner.enrollment.createLocal"))
    ) {
      const command = hostApi["commands.dispatch"].payload.parse(JSON.parse(request.body));
      const response: unknown = JSON.parse(result.body);
      const envelope = z
        .object({ ok: z.literal(true), data: hostApi["commands.dispatch"].success })
        .safeParse(response);
      if (envelope.success)
        await this.#observeCommand(selected.resolved.deploymentId, command, envelope.data.data);
    }
    return result;
  }

  /** Main-process app traffic keeps the attachment fence until its streamed body ends. */
  streamApp(input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: ReadableStream<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<Response> {
    let resolve!: (response: Response) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<Response>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void this.exchange(
      { ...input, credentials: "omit", redirect: "manual", headers: { additional: input.headers } },
      async (response, progress) => {
        if (!response.body) {
          resolve(response);
          return;
        }
        const { body, done } = streamBoundedResponse(response, {
          ...progress,
          maximumBytes: Number.MAX_SAFE_INTEGER,
        });
        resolve(
          new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
        );
        await done;
      },
      "app-stream",
    ).catch(reject);
    return ready;
  }

  async openBinary(ownerId: number, input: unknown): Promise<{ readonly transferId: string }> {
    const parsed = DesktopHostBinaryOpenInputSchema.parse(input);
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error("Invalid binary owner.");
    if (this.#binary.size + this.#openingBinary >= maximumBinaryTransfers)
      throw new Error("Too many binary transfers are open.");
    this.#openingBinary += 1;
    let directory: string | null = null;
    try {
      const transport = await this.#transport(parsed.expectedDeploymentId);
      const selected = await transport.current();
      if (
        parsed.expectedDeploymentId !== undefined &&
        selected.resolved.deploymentId !== parsed.expectedDeploymentId
      )
        throw new HostTransportError("deployment-changed");
      const attachmentKey = transport.currentKey();
      if (!attachmentKey) throw new Error("No deployment is attached.");
      directory = await fs.mkdtemp(join(tmpdir(), "opensteer-attachment-"));
      await ensurePrivateDirectory(directory);
      const filePath = join(directory, "bytes");
      await fs.writeFile(filePath, new Uint8Array(), { mode: 0o600 });
      await setPrivateFileMode(filePath);
      const transferId = globalThis.crypto.randomUUID();
      const controller = new AbortController();
      const result = DesktopHostBinaryOpenResultSchema.parse({ transferId });
      const transfer: BinaryTransfer = {
        transport,
        attachmentKey,
        controller,
        directory,
        input: parsed,
        offset: 0,
        outcome:
          parsed.method === "GET"
            ? this.#downloadBinary(transport, attachmentKey, parsed, filePath, controller.signal)
            : null,
        ownerId,
        path: filePath,
        size: 0,
      };
      this.#binary.set(transferId, transfer);
      this.#touchBinary(transferId, transfer);
      if (transfer.outcome) void transfer.outcome.catch(() => undefined);
      directory = null;
      return result;
    } finally {
      this.#openingBinary -= 1;
      if (directory) await fs.rm(directory, { force: true, recursive: true });
    }
  }

  async writeBinary(ownerId: number, input: unknown): Promise<void> {
    const parsed = DesktopHostBinaryWriteInputSchema.parse(input);
    const transfer = this.#ownedBinary(ownerId, parsed.transferId);
    this.#touchBinary(parsed.transferId, transfer);
    if (transfer.input.method !== "POST") throw new Error("This transfer cannot receive bytes.");
    if (transfer.size + parsed.bytes.byteLength > binaryByteLimit(transfer.input)) {
      throw new Error("The attachment exceeds the Desktop transfer limit.");
    }
    this.#assertBinaryAttachment(transfer);
    await fs.appendFile(transfer.path, parsed.bytes);
    transfer.size += parsed.bytes.byteLength;
  }

  async finishBinary(ownerId: number, input: unknown): Promise<DesktopHostHttpResponse> {
    const parsed = DesktopHostBinaryTransferInputSchema.parse(input);
    const transfer = this.#ownedBinary(ownerId, parsed.transferId);
    this.#touchBinary(parsed.transferId, transfer);
    if (transfer.input.method !== "POST") throw new Error("This transfer cannot be finished.");
    this.#assertBinaryAttachment(transfer);
    try {
      const body = await openAsBlob(transfer.path);
      return await transfer.transport.exchange(
        {
          body,
          expectedAttachmentKey: transfer.attachmentKey,
          expectedDeploymentId: transfer.input.expectedDeploymentId,
          headers: binaryHeaders(transfer.input),
          method: "POST",
          path: transfer.input.path,
          signal: transfer.controller.signal,
          ...(transfer.input.timeoutMs ? { timeoutMs: transfer.input.timeoutMs } : {}),
        },
        async (response, progress) =>
          DesktopHostHttpResponseSchema.parse({
            body: await readBoundedText(response, {
              ...progress,
              fatalUtf8: true,
              invalidContentLengthError: () =>
                new Error("The Host returned an invalid content length."),
              maximumBytes: maximumHostResponseBytes,
              sizeError: () => new HostTransportError("response-too-large"),
            }),
            headers: { contentType: response.headers.get("content-type") },
            status: response.status,
          }),
      );
    } finally {
      await this.closeBinary(ownerId, parsed);
    }
  }

  async readBinary(
    ownerId: number,
    input: unknown,
  ): Promise<import("@opensteer/protocol/desktop").DesktopHostBinaryReadResult> {
    const parsed = DesktopHostBinaryTransferInputSchema.parse(input);
    const transfer = this.#ownedBinary(ownerId, parsed.transferId);
    this.#touchBinary(parsed.transferId, transfer);
    if (!transfer.outcome) throw new Error("This transfer cannot be read.");
    const outcome = await transfer.outcome;
    transfer.size = outcome.sizeBytes;
    this.#assertBinaryAttachment(transfer);
    const handle = await fs.open(transfer.path, "r");
    try {
      const bytes = new Uint8Array(Math.min(binaryChunkBytes, transfer.size - transfer.offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, transfer.offset);
      transfer.offset += bytesRead;
      return DesktopHostBinaryReadResultSchema.parse({
        bytes: bytes.subarray(0, bytesRead),
        contentType: outcome.contentType,
        done: transfer.offset >= transfer.size,
        etag: outcome.etag,
        fileSizeBytes: outcome.fileSizeBytes,
        fileTruncated: outcome.fileTruncated,
        lastModified: outcome.lastModified,
        sizeBytes: outcome.sizeBytes,
        status: outcome.status,
      });
    } finally {
      await handle.close();
    }
  }

  async closeBinary(ownerId: number, input: unknown): Promise<void> {
    const parsed = DesktopHostBinaryTransferInputSchema.parse(input);
    const transfer = this.#ownedBinary(ownerId, parsed.transferId);
    this.#binary.delete(parsed.transferId);
    clearTimeout(transfer.idleTimer);
    transfer.controller.abort(new HostTransportError("cancelled"));
    await fs.rm(transfer.directory, { force: true, recursive: true });
  }

  async closeBinaryForOwner(ownerId: number): Promise<void> {
    for (const [transferId, transfer] of this.#binary) {
      if (transfer.ownerId === ownerId) await this.closeBinary(ownerId, { transferId });
    }
  }

  async #downloadBinary(
    transport: HostTransport,
    attachmentKey: string,
    input: DesktopHostBinaryOpenInput,
    path: string,
    signal: AbortSignal,
  ): Promise<{
    readonly status: number;
    readonly contentType: string | null;
    readonly etag: string | null;
    readonly fileSizeBytes: number | null;
    readonly fileTruncated: boolean | null;
    readonly lastModified: string | null;
    readonly sizeBytes: number;
  }> {
    return transport.exchange(
      {
        expectedAttachmentKey: attachmentKey,
        expectedDeploymentId: input.expectedDeploymentId,
        headers: binaryHeaders(input),
        method: input.method,
        path: input.path,
        signal,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      },
      async (response, progress) => {
        if (transport.currentKey() !== attachmentKey)
          throw new HostTransportError("deployment-changed");
        const size = await forEachBoundedResponseChunk(
          response,
          {
            ...progress,
            maximumBytes: binaryByteLimit(input),
            sizeError: () => new HostTransportError("response-too-large"),
          },
          (chunk) => fs.appendFile(path, chunk),
        );
        const fileSizeHeader = response.headers.get("x-opensteer-file-size");
        const fileTruncatedHeader = response.headers.get("x-opensteer-file-truncated");
        if (
          fileSizeHeader !== null &&
          (!/^(0|[1-9][0-9]*)$/.test(fileSizeHeader) ||
            !Number.isSafeInteger(Number(fileSizeHeader)))
        )
          throw new Error("The Host returned an invalid file size.");
        if (
          fileTruncatedHeader !== null &&
          fileTruncatedHeader !== "true" &&
          fileTruncatedHeader !== "false"
        )
          throw new Error("The Host returned an invalid file truncation flag.");
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          etag: response.headers.get("etag"),
          fileSizeBytes: fileSizeHeader === null ? null : Number(fileSizeHeader),
          fileTruncated: fileTruncatedHeader === null ? null : fileTruncatedHeader === "true",
          lastModified: response.headers.get("last-modified"),
          sizeBytes: size,
        };
      },
    );
  }

  #ownedBinary(ownerId: number, transferId: string): BinaryTransfer {
    const transfer = this.#binary.get(transferId);
    if (!transfer || transfer.ownerId !== ownerId)
      throw new Error("This binary transfer belongs to another renderer.");
    return transfer;
  }

  #touchBinary(transferId: string, transfer: BinaryTransfer): void {
    clearTimeout(transfer.idleTimer);
    transfer.idleTimer = setTimeout(() => {
      void this.closeBinary(transfer.ownerId, { transferId }).catch(() => undefined);
    }, binaryIdleMilliseconds);
    transfer.idleTimer.unref();
  }

  #assertBinaryAttachment(transfer: BinaryTransfer): void {
    if (transfer.transport.currentKey() !== transfer.attachmentKey)
      throw new HostTransportError("deployment-changed");
  }

  async openWebSocket(
    ownerId: number,
    input: unknown,
    onEvent: (event: DesktopHostWebSocketEvent) => void,
  ): Promise<{ readonly connectionId: string }> {
    const parsed = DesktopOpenHostWebSocketInputSchema.parse(input);
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error("Invalid socket owner.");
    const connectionId = `desktop_host_socket_${globalThis.crypto.randomUUID()}`;
    // The IPC connection id authorizes renderer commands; diagnostics get an
    // independent id which cannot be used to send or close a socket.
    const socketId = `host_socket_${globalThis.crypto.randomUUID()}`;
    const ownerGeneration = this.#ownerGenerations.get(ownerId) ?? 0;
    const transport = await this.#transport(parsed.expectedDeploymentId);
    const selected = await transport.current();
    if (
      parsed.expectedDeploymentId !== undefined &&
      selected.resolved.deploymentId !== parsed.expectedDeploymentId
    )
      throw new HostTransportError("deployment-changed");
    const generation = this.#socketGenerations.get(transport) ?? 0;
    const browser = browserSocketPath(parsed.path);
    const diagnostic = hostSocketDiagnostic(parsed.path);
    const diagnose = (event: string, fields: Record<string, string | number | boolean> = {}) => {
      try {
        this.#log?.(event, { socketId, ...diagnostic, ...fields });
      } catch {
        // A logger cannot change socket ownership or delivery.
      }
    };
    let presentedSurface: string | null = null;
    let consumerToken: string | null = null;
    let viewerToken: string | null = null;
    const diagnoseTarget = (data: string | Uint8Array) => {
      if (diagnostic.kind !== "browser" || typeof data !== "string") return;
      try {
        const message = BrowserClientMessageSchema.safeParse(JSON.parse(data));
        if (
          browser &&
          admitted &&
          message.success &&
          (message.data.type === "stream.subscribe" || message.data.type === "stream.unsubscribe")
        ) {
          presentedSurface =
            message.data.type === "stream.subscribe" ? (message.data.surfaceId ?? null) : null;
          for (const listener of this.#browserControlListeners)
            listener({
              connectionId,
              ownerId,
              ...browser,
              type: "presentation",
              surfaceId:
                message.data.type === "stream.subscribe" ? (message.data.surfaceId ?? null) : null,
            });
        }
        if (
          message.success &&
          message.data.type === "stream.subscribe" &&
          message.data.surfaceId &&
          diagnostic.surfaceCorrelationId !==
            this.#surfaceCorrelationId(diagnostic.sessionId, message.data.surfaceId)
        ) {
          diagnostic.surfaceCorrelationId = this.#surfaceCorrelationId(
            diagnostic.sessionId,
            message.data.surfaceId,
          );
          diagnose("desktop.host-socket.target");
        }
      } catch {
        // Only a validated target selection contributes diagnostic metadata.
      }
    };
    const startedAt = performance.now();
    let closed = false;
    let admitted = false;
    const observe = (type: DesktopBrowserSocketObservation["type"]) => {
      if (browser)
        for (const listener of this.#browserControlListeners) {
          try {
            listener({ connectionId, ownerId, ...browser, type });
          } catch {
            /* Observers cannot retain a socket. */
          }
        }
      if (browser)
        for (const listener of this.#browserSocketListeners) {
          try {
            listener({ connectionId, ownerId, ...browser, type });
          } catch {
            // An observer cannot keep a renderer's socket alive.
          }
        }
    };
    const release = () => {
      if (closed) return;
      closed = true;
      this.#sockets.delete(connectionId);
      observe("closed");
    };
    const deliver = (event: OutboundSocketEvent): boolean => {
      if (closed && event.type !== "close") return true;
      const output = DesktopHostWebSocketEventSchema.safeParse({ connectionId, ...event });
      if (!output.success) return false;
      try {
        onEvent(output.data);
        return true;
      } catch {
        return false;
      }
    };
    // Every way a connection ends comes through here, whichever side ends it,
    // so the renderer hears exactly one close: one never told keeps a socket it
    // believes open, and nothing it does will replace it.
    const end = (code: number, reason: string, initiator: SocketEndInitiator): void => {
      if (closed) return;
      release();
      const closeCode = Number.isInteger(code) && code >= 0 && code <= 4_999 ? code : 1_006;
      const closeReason = boundedMessage(reason);
      deliver({ code: closeCode, reason: closeReason, type: "close" });
      diagnose("desktop.host-socket.closed", {
        code: closeCode,
        reason: socketDiagnosticReasons.has(closeReason) ? closeReason : "other",
        initiator,
        lifetimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    };
    const network = await transport
      .openSocket({ path: parsed.path }, (socket) => {
        if (transport.currentKey() !== selected.resolved.key || this.#disposed)
          throw new HostTransportError("deployment-changed");
        if (
          generation !== (this.#socketGenerations.get(transport) ?? 0) ||
          ownerGeneration !== (this.#ownerGenerations.get(ownerId) ?? 0)
        ) {
          end(4_001, "Deployment changed", "deployment-changed");
          socket.close(4_001, "Deployment changed");
        }
        const invalidate = (code: number, reason: string, ownerMessage: string): void => {
          if (closed) return;
          deliver({ message: ownerMessage, type: "error" });
          end(code, reason, "undeliverable");
          socket.close(code, reason);
        };
        return {
          close: (code, reason) => end(code, reason, "network"),
          error: (message) => {
            if (closed) return;
            if (
              !deliver({ message: boundedMessage(message) || "Host socket failed.", type: "error" })
            )
              invalidate(
                consumerUnavailableCloseCode,
                "Client unavailable",
                "The client could not receive this frame.",
              );
          },
          message: (data) => {
            if (closed) return;
            if (browser && !admitted && typeof data === "string") {
              let message: unknown;
              try {
                message = JSON.parse(data);
              } catch {
                message = null;
              }
              const snapshot = BrowserServerMessageSchema.safeParse(message);
              if (
                snapshot.success &&
                snapshot.data.type === "browser.snapshot" &&
                snapshot.data.sessionId === browser.sessionId
              ) {
                consumerToken =
                  snapshot.data.passkeys === "native" || snapshot.data.passkeys === "notice"
                    ? (snapshot.data.passkeyConsumerToken ?? null)
                    : null;
                viewerToken = snapshot.data.consumerToken ?? null;
                admitted = true;
                observe("admitted");
              }
            }
            let rendererData = data;
            if (browser && admitted && typeof data === "string") {
              let raw: unknown = null;
              try {
                raw = JSON.parse(data);
                const message = BrowserServerMessageSchema.parse(raw);
                for (const listener of this.#browserControlListeners)
                  listener({ connectionId, ownerId, ...browser, type: "message", message });
                // Main presents the request; the renderer learns only that its offer ended.
                if (message.type === "browser.passkey.request")
                  rendererData = JSON.stringify({
                    type: "browser.passkey.withdrawn",
                    requestId: message.requestId,
                  });
              } catch {
                /* The renderer's existing protocol boundary reports invalid frames. */
              }
              // A malformed request still never carries its ceremony details to the renderer.
              if (
                rendererData === data &&
                typeof raw === "object" &&
                raw !== null &&
                (raw as { type?: unknown }).type === "browser.passkey.request"
              )
                return;
            }
            if (
              !deliver(
                typeof rendererData === "string"
                  ? { data: rendererData, type: "text" }
                  : { data: new Uint8Array(rendererData), type: "binary" },
              )
            )
              invalidate(
                invalidHostFrameCloseCode,
                "Invalid Host frame",
                "The Host sent an invalid frame.",
              );
          },
          open: () => {
            if (!closed) diagnose("desktop.host-socket.opened");
            if (!closed && !deliver({ type: "open" }))
              invalidate(
                consumerUnavailableCloseCode,
                "Client unavailable",
                "The client could not receive this frame.",
              );
          },
        };
      })
      .catch((error: unknown) => {
        release();
        throw error;
      });
    if (
      !closed &&
      generation === (this.#socketGenerations.get(transport) ?? 0) &&
      ownerGeneration === (this.#ownerGenerations.get(ownerId) ?? 0)
    )
      this.#sockets.set(connectionId, {
        end,
        network,
        transport,
        ownerId,
        diagnoseTarget,
        passkeyConsumer: (surfaceId) =>
          admitted && presentedSurface === surfaceId ? consumerToken : null,
        viewerConsumer: (surfaceId) =>
          admitted && presentedSurface === surfaceId ? viewerToken : null,
      });
    else if (!closed) {
      end(4_001, "Deployment changed", "deployment-changed");
      network.close(4_001, "Deployment changed");
    }
    return DesktopOpenHostWebSocketResultSchema.parse({ connectionId });
  }

  sendWebSocket(ownerId: number, input: unknown): void {
    const command = DesktopHostWebSocketCommandSchema.parse(input);
    const socket = this.#ownedSocket(ownerId, command.connectionId);
    if (typeof command.data === "string") {
      let value: unknown;
      try {
        value = JSON.parse(command.data);
      } catch {
        value = null;
      }
      const message = BrowserClientMessageSchema.safeParse(value);
      if (message.success && message.data.type.startsWith("passkey."))
        throw new Error("Passkeys are answered by desktop main.");
    }
    socket.diagnoseTarget(command.data);
    socket.network.send(command.data);
  }

  closeWebSocket(ownerId: number, input: unknown): void {
    const parsed = DesktopCloseHostWebSocketInputSchema.parse(input);
    const socket = this.#ownedSocket(ownerId, parsed.connectionId);
    socket.end(parsed.code ?? 1_005, parsed.reason ?? "", "renderer");
    socket.network.close(parsed.code, parsed.reason);
  }

  closeSocketsForOwner(ownerId: number): void {
    this.#ownerGenerations.set(ownerId, (this.#ownerGenerations.get(ownerId) ?? 0) + 1);
    for (const socket of this.#sockets.values()) {
      if (socket.ownerId !== ownerId) continue;
      socket.end(1_000, "Client closed", "owner-gone");
      socket.network.close(1_000, "Client closed");
    }
  }

  override closeAllSockets(): void {
    this.#closeTransportSockets(this);
    super.closeAllSockets();
  }

  #closeTransportSockets(transport: HostTransport): void {
    this.#socketGenerations.set(transport, (this.#socketGenerations.get(transport) ?? 0) + 1);
    for (const socket of this.#sockets.values()) {
      if (socket.transport === transport)
        socket.end(4_001, "Deployment changed", "deployment-changed");
    }
    for (const [transferId, transfer] of this.#binary) {
      if (transfer.transport === transport)
        void this.closeBinary(transfer.ownerId, { transferId }).catch(() => undefined);
    }
  }

  override async current(): Promise<import("@opensteer/client/auth").SelectedAttachment> {
    const selected = await super.current();
    this.#selectedDeploymentId = selected.resolved.deploymentId;
    return selected;
  }

  closeDeploymentConnections(deploymentId: DeploymentId): void {
    // The selected transport caches its identity; do not resolve a different route during fencing.
    if (this.#selectedDeploymentId === deploymentId) this.invalidateSession();
    const summary = this.#summaries.get(deploymentId);
    if (summary) {
      this.#closeTransportSockets(summary);
      summary.invalidateSession();
    }
    const team = this.#teams.get(deploymentId);
    if (team) {
      this.#closeTransportSockets(team);
      team.invalidateSession();
    }
  }

  closeAllConnections(): void {
    this.closeAllSockets();
    for (const team of this.#teams.values()) {
      this.#closeTransportSockets(team);
      team.closeAllSockets();
    }
    for (const summary of this.#summaries.values()) summary.closeAllSockets();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeCatalog();
    this.closeAllConnections();
    this.#teams.clear();
    this.#summaries.clear();
  }

  async #transport(deploymentId?: DeploymentId, summary = false): Promise<HostTransport> {
    if (this.#disposed) throw new HostTransportError("cancelled");
    if (deploymentId === undefined) return this;
    const catalog = await this.#catalog.load();
    if (this.#disposed) throw new HostTransportError("cancelled");
    const connection = catalog.deployments.find(
      ({ authority }) => authority.document.deploymentId === deploymentId,
    );
    if (!connection) throw new HostTransportError("deployment-changed");
    if (connection.authority.document.deploymentShape.kind !== "team") {
      if (!summary || catalog.selectedDeploymentId === deploymentId) return this;
      let transport = this.#summaries.get(deploymentId);
      if (!transport) {
        transport = new HostTransport({
          ...this.#teamOptions,
          expectedKind: "personal",
          deploymentId,
        });
        this.#summaries.set(deploymentId, transport);
      }
      return transport;
    }
    const existing = this.#teams.get(deploymentId);
    if (existing) return existing;
    const team = new HostTransport({ ...this.#teamOptions, deploymentId });
    team.onAttachmentInvalidated(() => this.#closeTransportSockets(team));
    this.#teams.set(deploymentId, team);
    return team;
  }

  observeBrowserSockets(listener: (event: DesktopBrowserSocketObservation) => void): () => void {
    this.#browserSocketListeners.add(listener);
    return () => {
      this.#browserSocketListeners.delete(listener);
    };
  }

  passkeyConsumerToken(ownerId: number, connectionId: string, surfaceId: string): string | null {
    const socket = this.#sockets.get(connectionId);
    return socket?.ownerId === ownerId ? socket.passkeyConsumer(surfaceId) : null;
  }

  viewerConsumerToken(ownerId: number, connectionId: string, surfaceId: string): string | null {
    const socket = this.#sockets.get(connectionId);
    return socket?.ownerId === ownerId ? socket.viewerConsumer(surfaceId) : null;
  }
  observeBrowserControl(listener: (event: DesktopBrowserControlObservation) => void): () => void {
    this.#browserControlListeners.add(listener);
    return () => {
      this.#browserControlListeners.delete(listener);
    };
  }
  sendBrowserControl(ownerId: number, connectionId: string, message: BrowserClientMessage): void {
    this.#ownedSocket(ownerId, connectionId).network.send(
      JSON.stringify(BrowserClientMessageSchema.parse(message)),
    );
  }
  openBrowserSurface(ownerId: number, connectionId: string, url: string): void {
    this.#ownedSocket(ownerId, connectionId).network.send(
      JSON.stringify(BrowserClientMessageSchema.parse({ type: "surface.open", url })),
    );
  }

  #ownedSocket(ownerId: number, connectionId: string): OwnedSocket {
    const socket = this.#sockets.get(connectionId);
    if (!socket || socket.ownerId !== ownerId) {
      throw new Error("This Host WebSocket belongs to another owner.");
    }
    return socket;
  }

  #surfaceCorrelationId(sessionId: string | undefined, surfaceId: string): string {
    // Surface ids are arbitrary strings. A per-transport key keeps even a URL
    // or credential out of logs and prevents guessing values from the digest.
    return `surface_${createHmac("sha256", this.#surfaceDiagnosticKey)
      .update(JSON.stringify([sessionId, surfaceId]))
      .digest("hex")}`;
  }
}

const socketDiagnosticReasons = new Set([
  "",
  "Client closed",
  "Deployment changed",
  "Host stopped",
  "Invalid frame",
  "Invalid Host protocol frame",
  "Invalid browser protocol frame",
  "Invalid Host frame",
  "Invalid realtime publication",
  "Client unavailable",
  "Target released",
  "Display viewer closed",
  "session-ended",
  "Phone disconnected",
  "Display stream ended",
  "Host is shutting down",
  "Liveness probe unanswered",
  "Liveness probe unsendable",
  "Realtime channel silent",
  "Realtime transport interrupted",
  "Subscription unsendable",
  "Fresh snapshot required",
  "Unsupported Opensteer protocol version",
  "slow consumer",
]);

function hostSocketDiagnostic(path: string): Record<string, string> {
  const { pathname, searchParams } = new URL(path, "https://host.invalid");
  if (pathname === "/v1/realtime") return { kind: "realtime" };
  const browser = /^\/v1\/browser-sessions\/([^/]+)\/connect$/.exec(pathname);
  if (browser) {
    const session = BrowserSessionIdSchema.safeParse(browser[1]);
    const mode = searchParams.get("mode") ?? "control";
    return {
      kind: "browser",
      mode: mode === "watch" || mode === "control" ? mode : "unknown",
      ...(session.success ? { sessionId: session.data } : {}),
    };
  }
  if (
    /^\/v1\/computer-use\/sessions\/[^/]+\/display$/.test(pathname) ||
    /^\/v1\/computer-use\/views\/[^/]+\/[^/]+\/display$/.test(pathname)
  )
    return { kind: "display" };
  return { kind: "other" };
}

function browserSocketPath(path: string): { sessionId: BrowserSessionId; mode: "control" } | null {
  const url = new URL(path, "https://host.invalid");
  const match = /^\/v1\/browser-sessions\/([^/]+)\/connect$/.exec(url.pathname);
  if (!match) return null;
  let sessionId: unknown;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const parsed = BrowserSessionIdSchema.safeParse(sessionId);
  const mode = url.searchParams.get("mode") ?? "control";
  return parsed.success && mode === "control" ? { sessionId: parsed.data, mode } : null;
}

function boundedMessage(value: string): string {
  const sanitized = value.replace(/[\r\n]/gu, " ");
  let result = "";
  let bytes = 0;
  for (const character of sanitized) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > 1_000) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function binaryByteLimit(input: DesktopHostBinaryOpenInput): number {
  if (!input.path.startsWith("/v1/team/files/")) return maximumBinaryBytes;
  if (input.path.endsWith("/preview")) return teamPreviewMaxBytes;
  return teamUploadMaxBytes + (input.method === "POST" ? teamPreviewMaxBytes : 0);
}

function binaryHeaders(input: DesktopHostBinaryOpenInput) {
  const { teamUpload, ...headers } = input.headers;
  return {
    ...headers,
    ...(teamUpload === undefined ? {} : { additional: { "x-opensteer-team-upload": teamUpload } }),
  };
}
