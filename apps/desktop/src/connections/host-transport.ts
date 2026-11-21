import { expectedMutationSessionHeader } from "@opensteer/protocol";
import { unwrapRpcResult } from "@opensteer/client/host";
import {
  forEachBoundedResponseChunk,
  readBoundedResponse,
  readBoundedText,
} from "@opensteer/shared/boundedJson";
import { streamBoundedResponse } from "@opensteer/shared/responseStream";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { attachmentMaxBytes, type DeploymentId } from "@opensteer/core";
import {
  hostApi,
  HostApiErrorSchema,
  hostApiCurrentHeader,
  hostApiVersionHeader,
  teamApiVersionHeader,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  fileTransferHeadersTimeoutMs,
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
} from "@opensteer/protocol";
import type {
  HostAttachment,
  HostSessionRecovery,
  SelectedAttachment,
} from "@opensteer/client/auth";
import {
  bufferedHostResponseTimeoutMs,
  classifyClientFailure,
  HostCapacityError,
  HostTransport,
  HostTransportError,
  HostRouteUnavailableError,
  type DeploymentCatalogStore,
  type HostCredentialProvider,
  type HostNetwork,
  type HostNetworkSocket,
} from "@opensteer/client/connections";
import {
  DesktopCancelHostRequestInputSchema,
  DesktopCloseHostWebSocketInputSchema,
  DesktopDeploymentSelectionSchema,
  desktopHostRequestIdHeader,
  DesktopHostRequestIdSchema,
  DesktopHostTransportErrorCodeSchema,
  type DesktopHostTransportErrorCode,
  desktopHostTransportErrorHeader,
  DesktopHostWebSocketCommandSchema,
  isDesktopHostUploadPath,
  DesktopHostWebSocketEventSchema,
  DesktopOpenHostWebSocketInputSchema,
  DesktopOpenHostWebSocketResultSchema,
  DesktopSelectDeploymentInputSchema,
  DesktopSetDeploymentRouteInputSchema,
  type DesktopDeploymentSelection,
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

const forwardedMethods = ["DELETE", "GET", "PATCH", "POST", "PUT"];
// The Host's own body limits: Fastify's default for JSON, and its binary routes'.
const maximumJsonRequestBytes = 1_024 * 1_024;
const teamFilesPath = "/v1/team/files/";
const teamUploadPath = "/v1/team/files/upload/";
const requestBodyStallTimeoutMs = 20_000;
const maximumEarlyCancellations = 64;
const maximumCommandResponseBytes = 1_024 * 1_024;
const forwardedRequestHeaders = {
  accept: "accept",
  "content-type": "contentType",
  "idempotency-key": "idempotencyKey",
  [hostApiVersionHeader]: "apiVersion",
  [teamApiVersionHeader]: "apiVersion",
  [hostApiCurrentHeader]: "apiCurrent",
} as const;
// Only what the bundled UI reads; cookies and transfer framing stay in main.
const forwardedResponseHeaders = [
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "last-modified",
  "retry-after",
  "x-opensteer-file-name",
  "x-opensteer-file-size",
  "x-opensteer-file-truncated",
];
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
  readonly #withPreparedEnrollment:
    | (<T>(
        deploymentId: DeploymentId,
        command: HostApiCommandInput,
        operation: () => Promise<T>,
      ) => Promise<T>)
    | undefined;
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
  readonly #browserControlListeners = new Set<(event: DesktopBrowserControlObservation) => void>();
  readonly #browserSocketListeners = new Set<(event: DesktopBrowserSocketObservation) => void>();
  readonly #ownerGenerations = new Map<number, number>();
  readonly #socketGenerations = new WeakMap<HostTransport, number>();
  readonly #forwarded = new Map<string, AbortController>();
  readonly #inflightSettled = new Map<string, Promise<void>>();
  /** Post-headers stream failures keyed by request id so the renderer recovers typed cancels. */
  readonly #streamErrors = new Map<string, DesktopHostTransportErrorCode>();
  /** Bumped when a Deployment's session changes; a request admitted before it isn't sent. */
  readonly #sessionEpochs = new Map<DeploymentId, number>();
  /** A cancel can overtake its request on the way to main. */
  readonly #cancelledEarly = new Set<string>();
  #selectedDeploymentId: DeploymentId | null = null;
  #disposed = false;

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
    readonly pinnedSessions?: (attachment: HostAttachment) => HostSessionRecovery;
    readonly withPreparedEnrollment?: <T>(
      deploymentId: DeploymentId,
      command: HostApiCommandInput,
      operation: () => Promise<T>,
    ) => Promise<T>;
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
    this.#withPreparedEnrollment = options.withPreparedEnrollment;
    this.#teamOptions = {
      catalog: options.catalog,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      localRuntime: {
        current: async () => desktopLocalHostRuntime(await options.localRuntime.current()),
      },
      network: options.network,
      ...(options.pinnedSessions === undefined ? {} : { sessions: options.pinnedSessions }),
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

  async bootstrapTeam(deploymentId: DeploymentId) {
    const transport = await this.#transport(deploymentId);
    const body = await transport.exchange(
      {
        expectedDeploymentId: deploymentId,
        path: "/v1/rpc/team.bootstrap.get",
        method: "POST",
        body: "{}",
        headers: { contentType: "application/json" },
      },
      (response, progress) =>
        readBoundedText(response, {
          ...progress,
          fatalUtf8: true,
          maximumBytes: 16 * 1_024 * 1_024,
          sizeError: () => new HostTransportError("response-too-large"),
        }),
    );
    return unwrapRpcResult(
      z
        .discriminatedUnion("ok", [
          z.object({ ok: z.literal(true), data: hostApi["team.bootstrap.get"].success }),
          z.object({ ok: z.literal(false), error: HostApiErrorSchema }),
        ])
        .parse(JSON.parse(body)),
    ).member;
  }

  /**
   * One request from the bundled UI, pinned to the Deployment it names, answered
   * with the Host's own status, content headers and bytes as they stream. The
   * body is read here first so a session that lapsed can be recovered and the
   * request replayed. A transport failure is named in a header.
   */
  forward(
    deploymentId: DeploymentId,
    path: string,
    request: Request,
    options: {
      /**
       * Main's own call to that Home, answered under that Home's own session
       * whether or not it is the selected one, as summary reads are.
       */
      readonly anyHome?: boolean;
    } = {},
  ): Promise<Response> {
    const requestId = DesktopHostRequestIdSchema.safeParse(
      request.headers.get(desktopHostRequestIdHeader),
    );
    const refused =
      !requestId.success || this.#forwarded.has(requestId.data) || this.#disposed
        ? 400
        : !forwardedMethods.includes(request.method)
          ? 405
          : null;
    if (refused !== null || !requestId.success) {
      void request.body?.cancel().catch(() => undefined);
      return Promise.resolve(new Response(null, { status: refused ?? 400 }));
    }
    const id = requestId.data;
    const controller = new AbortController();
    this.#forwarded.set(id, controller);
    if (this.#cancelledEarly.delete(id)) controller.abort(new HostTransportError("cancelled"));
    // A caller in main, such as the menu bar's bounded reads, cancels through its own signal.
    const cancelled = () => controller.abort(new HostTransportError("cancelled"));
    if (request.signal.aborted) cancelled();
    else request.signal.addEventListener("abort", cancelled, { once: true });
    // Taken before anything awaits: a sign-in again during the lookups below is another
    // session, and a personal selection that moves away and back is another attachment. A
    // request for a Deployment main hadn't yet resolved as selected is held from resolution.
    const epoch = this.#sessionEpoch(deploymentId);
    const selection =
      this.#selectedDeploymentId === deploymentId ? this.retainSelection() : () => undefined;
    const sameSession = () => {
      if (this.#sessionEpoch(deploymentId) !== epoch)
        throw new HostTransportError("deployment-changed");
    };
    let settled: Promise<void> = Promise.resolve();
    return this.#forward(
      id,
      deploymentId,
      path,
      request,
      controller.signal,
      sameSession,
      selection,
      (exchange) => {
        settled = exchange;
        this.#inflightSettled.set(id, exchange);
      },
      options.anyHome === true,
    )
      .catch((error: unknown) => this.#refused(path, error))
      .finally(
        () =>
          void settled.finally(() => {
            request.signal.removeEventListener("abort", cancelled);
            this.#forwarded.delete(id);
            if (this.#inflightSettled.get(id) === settled) this.#inflightSettled.delete(id);
          }),
      );
  }

  /** Consumes main's recorded transport failure for a response whose body aborted mid-stream. */
  async takeStreamError(requestId: string): Promise<DesktopHostTransportErrorCode | null> {
    const parsed = DesktopHostRequestIdSchema.safeParse(requestId);
    if (!parsed.success) return null;
    const id = parsed.data;
    const existing = this.#streamErrors.get(id);
    if (existing) {
      this.#streamErrors.delete(id);
      return existing;
    }
    const inflight = this.#inflightSettled.get(id);
    if (inflight) {
      await Promise.race([
        inflight,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          timer.unref?.();
        }),
      ]);
    }
    const recorded = this.#streamErrors.get(id) ?? null;
    if (recorded) this.#streamErrors.delete(id);
    return recorded;
  }

  /**
   * Main's own refusal of a window request, recorded by route and code so the
   * log says why a window couldn't open. The window's own cancel is not one.
   */
  #logRefusal(path: string, error: unknown): void {
    const failure = classifyClientFailure(error);
    if (failure.kind !== "cancelled" || failure.reason === "deployment-changed") {
      try {
        this.#log?.("desktop.host-route.refused", {
          route: hostRouteLabel(path),
          code: failure.code,
        });
      } catch {
        /* Diagnostics cannot change the answer. */
      }
    }
  }

  #refused(path: string, error: unknown): Response {
    this.#logRefusal(path, error);
    return transportFailure(error);
  }

  #recordStreamError(id: string, path: string, error: unknown): void {
    this.#logRefusal(path, error);
    const code =
      error instanceof HostTransportError
        ? DesktopHostTransportErrorCodeSchema.safeParse(error.code)
        : error instanceof HostRouteUnavailableError
          ? { success: true as const, data: "unreachable" as const }
          : { success: false as const };
    if (!code.success) return;
    this.#streamErrors.set(id, code.data);
    if (this.#streamErrors.size > 256)
      this.#streamErrors.delete(this.#streamErrors.keys().next().value!);
  }

  async #forward(
    requestId: string,
    deploymentId: DeploymentId,
    path: string,
    request: Request,
    signal: AbortSignal,
    sameSession: () => void,
    sameSelection: () => void,
    relaying: (settled: Promise<void>) => void,
    anyHome = false,
  ): Promise<Response> {
    const pathname = path.split("?", 1)[0]!;
    const headers: Partial<Record<ForwardedHeader, string>> = {};
    for (const [name, field] of Object.entries(forwardedRequestHeaders)) {
      const value = request.headers.get(name);
      if (value !== null) headers[field] = value;
    }
    const teamUpload = request.headers.get("x-opensteer-team-upload");
    const expectedSession = request.headers.get(expectedMutationSessionHeader);
    const summary =
      anyHome ||
      (request.method === "POST" &&
        (pathname === "/v1/rpc/attention.get" || pathname === "/v1/rpc/teams.links.list"));
    // Every wait before the exchange ends with the caller's signal, too.
    const transport = await untilAborted(this.#transport(deploymentId, summary), signal);
    // Only the personal selection's own requests answer to it; team and chooser reads don't.
    const arrived =
      transport === this
        ? () => {
            sameSession();
            sameSelection();
          }
        : sameSession;
    arrived();
    let body: Uint8Array<ArrayBuffer> | undefined;
    let attachment: SelectedAttachment | undefined;
    let admitted = arrived;
    if (request.body) {
      // The body can take a while; the Account, route and attachment it was sent under are
      // fixed first, and every send of it, a replay included, is checked against them.
      attachment = await untilAborted(transport.current(), signal);
      if (attachment.resolved.deploymentId !== deploymentId)
        throw new HostTransportError("deployment-changed");
      const retained = transport.retainAuthorization(attachment);
      admitted = () => {
        arrived();
        retained();
      };
      admitted();
      const read = await readRequestBody(request, requestByteLimit(pathname), signal);
      if (!read) return hostRefusal(413, "bad_request", "Request body is too large", false);
      body = read;
      admitted();
    }
    // An upload's bytes go out before its answer, and a team Host fetches a partner's file
    // before it answers: these wait longer for headers, but never without bound.
    const timeoutMs =
      isDesktopHostUploadPath(pathname) || pathname.startsWith(teamFilesPath)
        ? fileTransferHeadersTimeoutMs
        : body
          ? bufferedHostResponseTimeoutMs(body.byteLength)
          : undefined;
    const forwarded = {
      expectedDeploymentId: deploymentId,
      ...(attachment ? { expectedAttachmentKey: attachment.resolved.key } : {}),
      admitted,
      headers: {
        ...headers,
        additional: {
          ...(teamUpload ? { "x-opensteer-team-upload": teamUpload } : {}),
          ...(expectedSession && pathname === "/v1/rpc/commands.dispatch"
            ? { [expectedMutationSessionHeader]: expectedSession }
            : {}),
        },
      },
      method: request.method,
      path,
      signal,
      ...(body ? { body } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    const command =
      pathname === "/v1/rpc/commands.dispatch" && body ? enrollmentCommand(body) : null;
    if (command) return this.#forwardEnrollment(transport, command, forwarded);
    const relayed = relay(
      transport,
      forwarded,
      (error) => this.#refused(path, error),
      (error) => this.#recordStreamError(requestId, path, error),
    );
    relaying(relayed.settled);
    return relayed.response;
  }

  /** Ends every request still being forwarded: the page that made them has gone. */
  cancelForwardedRequests(): void {
    this.#cancelledEarly.clear();
    for (const controller of this.#forwarded.values())
      controller.abort(new HostTransportError("cancelled"));
  }

  /** A renderer's abort: Electron gives the protocol handler a Request without its signal. */
  cancelRequest(input: unknown): void {
    const { requestId } = DesktopCancelHostRequestInputSchema.parse(input);
    const controller = this.#forwarded.get(requestId);
    if (controller) {
      controller.abort(new HostTransportError("cancelled"));
      return;
    }
    this.#cancelledEarly.add(requestId);
    if (this.#cancelledEarly.size > maximumEarlyCancellations)
      this.#cancelledEarly.delete(this.#cancelledEarly.values().next().value!);
  }

  /**
   * Main owns this Mac's device key, so it prepares enrollment before the Host
   * issues a token and records the issued token before the renderer sees it.
   */
  async #forwardEnrollment(
    transport: HostTransport,
    command: HostApiCommandInput,
    request: Parameters<HostTransport["exchange"]>[0] & {
      readonly expectedDeploymentId: DeploymentId;
    },
  ): Promise<Response> {
    const deploymentId = request.expectedDeploymentId;
    const exchange = async () => {
      const response = await transport.exchange(request, async (response, progress) => ({
        bytes: await readBoundedResponse(response, {
          ...progress,
          maximumBytes: maximumCommandResponseBytes,
          sizeError: () => new HostTransportError("response-too-large"),
        }),
        headers: responseHeaders(response.headers),
        status: response.status,
      }));
      if (response.status === 200 && this.#observeCommand) {
        const envelope = z
          .object({ ok: z.literal(true), data: hostApi["commands.dispatch"].success })
          .safeParse(parseJson(response.bytes));
        if (envelope.success) await this.#observeCommand(deploymentId, command, envelope.data.data);
      }
      return new Response(response.bytes, {
        status: response.status,
        headers: response.headers,
      });
    };
    return this.#withPreparedEnrollment
      ? this.#withPreparedEnrollment(deploymentId, command, exchange)
      : exchange();
  }

  /** Main-process app traffic keeps the attachment fence until its streamed body ends. */
  mediaTransport(deploymentId: DeploymentId): Promise<HostTransport> {
    return this.#transport(deploymentId, true);
  }

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
  }

  override async current(): Promise<import("@opensteer/client/auth").SelectedAttachment> {
    const selected = await super.current();
    this.#selectedDeploymentId = selected.resolved.deploymentId;
    return selected;
  }

  closeDeploymentConnections(deploymentId: DeploymentId): void {
    this.#sessionEpochs.set(deploymentId, this.#sessionEpoch(deploymentId) + 1);
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

  #sessionEpoch(deploymentId: DeploymentId): number {
    return this.#sessionEpochs.get(deploymentId) ?? 0;
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
    this.cancelForwardedRequests();
    this.#unsubscribeCatalog();
    this.closeAllConnections();
    for (const team of this.#teams.values()) team.retire();
    this.#teams.clear();
    this.#summaries.clear();
    this.#streamErrors.clear();
  }

  async #transport(deploymentId?: DeploymentId, summary = false): Promise<HostTransport> {
    if (this.#disposed) throw new HostTransportError("cancelled");
    if (deploymentId === undefined) return this;
    const owner = this.#teamOptions.credentials?.teamRuntime?.();
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
    if (owner?.signal.aborted) throw new HostTransportError("deployment-changed");
    const existing = this.#teams.get(deploymentId);
    if (existing) return existing;
    const team = new HostTransport({ ...this.#teamOptions, deploymentId });
    team.onAttachmentInvalidated(() => this.#closeTransportSockets(team));
    this.#teams.set(deploymentId, team);
    owner?.own(() => {
      this.#closeTransportSockets(team);
      team.retire();
      this.#teams.delete(deploymentId);
    });
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

type ForwardedHeader = (typeof forwardedRequestHeaders)[keyof typeof forwardedRequestHeaders];

/** Streams one Host response through, keeping the exchange's fence and deadlines until it ends. */
function relay(
  transport: HostTransport,
  request: Parameters<HostTransport["exchange"]>[0],
  refused: (error: unknown) => Response,
  streamFailed: (error: unknown) => void,
): { readonly response: Promise<Response>; readonly settled: Promise<void> } {
  const ready = Promise.withResolvers<Response>();
  let headersSent = false;
  const settled = transport
    .exchange(request, async (response, progress) => {
      const init = { status: response.status, headers: responseHeaders(response.headers) };
      if (!response.body || [204, 205, 304].includes(response.status)) {
        headersSent = true;
        ready.resolve(new Response(null, init));
        return;
      }
      const { body, done } = streamBoundedResponse(response, {
        ...progress,
        maximumBytes: Number.MAX_SAFE_INTEGER,
      });
      headersSent = true;
      ready.resolve(new Response(body, init));
      await done;
    })
    .catch((error: unknown) => {
      if (headersSent) streamFailed(error);
      else ready.resolve(refused(error));
    });
  return { response: ready.promise, settled };
}

/** A fixed name for a Host route, never text taken from the path itself. */
function hostRouteLabel(path: string): string {
  const pathname = path.split("?", 1)[0]!;
  const rpc = /^\/v1\/rpc\/([^/]+)$/u.exec(pathname)?.[1];
  if (rpc !== undefined && Object.hasOwn(hostApi, rpc)) return rpc;
  if (isDesktopHostUploadPath(pathname)) return "upload";
  if (pathname.startsWith(teamFilesPath)) return "team-files";
  return "other";
}

class RequestBodyTooLargeError extends Error {}

/**
 * The body read once, under its route's limit, as the one copy a 401 replay
 * sends again: Electron hands a Blob's bytes over as a single chunk, kept as it
 * is. The body is already on this computer, so a stall means it never will be.
 */
async function readRequestBody(
  request: Request,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const length = request.headers.get("content-length");
  const stalled = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => stalled.abort(new HostTransportError("timed-out")),
      requestBodyStallTimeoutMs,
    );
  };
  wait();
  try {
    await forEachBoundedResponseChunk(
      new Response(request.body, length === null ? {} : { headers: { "content-length": length } }),
      {
        maximumBytes,
        onProgress: wait,
        signal: AbortSignal.any([signal, stalled.signal]),
        sizeError: () => new RequestBodyTooLargeError(),
      },
      (chunk) => {
        chunks.push(chunk as Uint8Array<ArrayBuffer>);
      },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requestByteLimit(pathname: string): number {
  if (pathname.startsWith(teamUploadPath)) return teamUploadMaxBytes + teamPreviewMaxBytes;
  return isDesktopHostUploadPath(pathname) ? attachmentMaxBytes : maximumJsonRequestBytes;
}

/** Main's own refusal, in the envelope and status the Host gives the same refusal. */
function hostRefusal(status: number, code: string, message: string, retryable: boolean): Response {
  return Response.json({ ok: false, error: { code, message, retryable } }, { status });
}

function responseHeaders(source: Headers): Headers {
  // Host bytes are data to the bundled UI, never a document it would render.
  const headers = new Headers({
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
  });
  for (const name of forwardedResponseHeaders) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function transportFailure(error: unknown): Response {
  if (error instanceof HostCapacityError)
    return hostRefusal(429, "resource_exhausted", error.message, true);
  const failure = classifyClientFailure(error);
  if (failure.code === "unauthorized")
    return Response.json(
      {
        ok: false,
        error: {
          code: failure.code,
          reason: failure.reason,
          message: "Sign in to continue.",
          retryable: false,
          provenance: failure.provenance,
        },
      },
      { status: 401 },
    );
  if (!(error instanceof HostTransportError || error instanceof HostRouteUnavailableError))
    return hostRefusal(500, "internal", "The desktop could not complete this request.", false);
  return new Response(null, {
    status: 502,
    headers: {
      [desktopHostTransportErrorHeader]:
        error instanceof HostTransportError ? error.code : "unreachable",
    },
  });
}

function enrollmentCommand(body: Uint8Array): HostApiCommandInput | null {
  const command = hostApi["commands.dispatch"].payload.safeParse(parseJson(body));
  return command.success && command.data.type === "runner.enrollment.createLocal"
    ? command.data
    : null;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** `work`, or the signal's reason as soon as it aborts; the work itself runs on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => {
      void work.catch(() => undefined);
      rejectPromise(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}
