import { z } from "zod";
import type { HostAttachment, HostSessionRecovery } from "../auth/host-session.js";
import {
  hostKeyFingerprint,
  personalHostAccessRouteEnvelopeSha256,
} from "@opensteer/deployment-authority";
import { readBoundedText } from "@opensteer/shared/boundedJson";
import {
  DesktopUpdateStatusSchema,
  DesktopUpdateOperationSchema,
  DesktopUpdateRequestSchema,
  type DesktopUpdateStatus,
  type DesktopUpdateOperation,
  type DesktopUpdateRequest,
} from "@opensteer/protocol/maintenance";
import {
  DesktopUpdatesError,
  desktopUpdatePath,
  desktopUpdateRequestTimeoutMs,
  followDesktopUpdates,
  readDesktopUpdateResponse,
  type DesktopUpdates,
} from "./desktop-updates-contract.js";
import { HostTransportError } from "./host-transport-error.js";
import { HostTransport, type HostTransportOptions } from "./host-transport.js";
import { verifyAccessEndpoint, verifyPersonalAccessEndpoint } from "./deployment-catalog.js";

export * from "./desktop-updates-contract.js";

/** Own transport lifetime: usable before attachment and after an epoch refusal. */
export class DesktopUpdatesService implements DesktopUpdates {
  readonly #transport: HostTransport;
  readonly #verificationTransport: HostTransport;
  #verifiedKey: string | null = null;
  constructor(
    options: Omit<HostTransportOptions, "sessions"> & {
      readonly sessions?: (attachment: HostAttachment) => HostSessionRecovery;
    },
  ) {
    const { credentials, sessions, ...routing } = options;
    // Credential lookup can refresh OAuth against the Host; verify before even looking it up.
    this.#verificationTransport = new HostTransport(routing);
    this.#transport = new HostTransport({
      ...routing,
      ...(credentials
        ? {
            credentials: {
              authorizationHeader: async (connection) => {
                await this.#verify();
                return credentials.authorizationHeader(connection);
              },
            },
          }
        : {}),
      ...(sessions
        ? {
            sessions: sessions({
              current: async () => {
                await this.#verify();
                return this.#verificationTransport.current();
              },
              currentKey: () => this.#verificationTransport.currentKey(),
            }),
          }
        : {}),
    });
  }
  invalidateSession(): void {
    this.#verifiedKey = null;
    this.#verificationTransport.invalidateSession();
    this.#transport.invalidateSession();
  }

  async status(
    options: { after?: string; signal?: AbortSignal } = {},
  ): Promise<DesktopUpdateStatus> {
    const query = options.after === undefined ? "" : `?after=${encodeURIComponent(options.after)}`;
    return this.#exchange("GET", query, undefined, DesktopUpdateStatusSchema, options.signal);
  }
  request(
    request: DesktopUpdateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<DesktopUpdateOperation> {
    return this.#exchange(
      "POST",
      "",
      DesktopUpdateRequestSchema.parse(request),
      DesktopUpdateOperationSchema,
      options.signal,
    );
  }
  subscribeWhileVisible(
    listener: (status: DesktopUpdateStatus) => void,
    options: { signal: AbortSignal; onError: (error: unknown) => void },
  ): () => void {
    return followDesktopUpdates(this, listener, options);
  }
  async #verify(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const selected = await this.#verificationTransport.current();
    if (selected.resolved.key === this.#verifiedKey) return selected.resolved;
    const { connection, resolved } = selected;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const requestSignal = init?.signal ?? signal;
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== resolved.origin) throw new DesktopUpdatesError("invalid-response");
      return this.#verificationTransport.exchange(
        {
          method: "GET",
          path: url.pathname,
          credentials: "omit",
          headers: { accept: "application/json" },
          expectedDeploymentId: resolved.deploymentId,
          expectedAttachmentKey: resolved.key,
          ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        },
        async (response, progress) => {
          const body = await readBoundedText(response, {
            maximumBytes: 65_536,
            signal: progress.signal,
            onProgress: progress.onProgress,
            sizeError: () => new DesktopUpdatesError("invalid-response"),
          });
          return new Response(body, { status: response.status, headers: response.headers });
        },
      );
    };
    const expected = {
      origin: resolved.origin,
      expectedDiscovery: connection.authority.document,
      expectedDeploymentId: resolved.deploymentId,
      fetch,
      protocol: "maintenance-v1" as const,
      ...(signal === undefined ? {} : { signal }),
    };
    if (resolved.route) {
      const verified = await verifyPersonalAccessEndpoint(expected);
      if (
        personalHostAccessRouteEnvelopeSha256(verified.accessRoute) !==
        personalHostAccessRouteEnvelopeSha256(resolved.route)
      )
        throw new DesktopUpdatesError("invalid-response");
    } else
      await verifyAccessEndpoint({
        ...expected,
        expectedHostKeyFingerprint: hostKeyFingerprint(connection.authority.publicKey.spki),
        kind:
          resolved.access === "owner"
            ? "canonical"
            : (connection.endpoints.find((endpoint) => endpoint.origin === resolved.origin)?.kind ??
              "canonical"),
      });
    if ((await this.#verificationTransport.current()).resolved.key !== resolved.key)
      throw new DesktopUpdatesError("invalid-response");
    this.#verifiedKey = resolved.key;
    return resolved;
  }
  async #exchange<T>(
    method: string,
    query: string,
    body: DesktopUpdateRequest | undefined,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const verified = await this.#verify(signal);
      return await this.#transport.exchange(
        {
          method,
          expectedDeploymentId: verified.deploymentId,
          expectedAttachmentKey: verified.key,
          path: `${desktopUpdatePath}${query}`,
          headers: {
            accept: "application/json",
            ...(body ? { contentType: "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: desktopUpdateRequestTimeoutMs,
        },
        (response, progress) => readDesktopUpdateResponse(response, schema, progress),
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DesktopUpdatesError) throw error;
      if (error instanceof HostTransportError) {
        if (error.code === "unreachable") throw new DesktopUpdatesError("offline");
        if (error.code === "timed-out") throw new DesktopUpdatesError("unavailable");
        throw error;
      }
      throw new DesktopUpdatesError("invalid-response");
    }
  }
}
