import { z } from "zod";
import {
  hostKeyFingerprint,
  personalHostAccessRouteEnvelopeSha256,
} from "@opensteer/deployment-authority";
import { readBoundedJson, readBoundedText } from "@opensteer/shared/boundedJson";
import {
  DesktopUpdateStatusSchema,
  DesktopUpdateOperationSchema,
  DesktopUpdateRequestSchema,
  desktopUpdateLongPollMs,
  desktopUpdateMaximumBytes,
  type DesktopUpdateStatus,
  type DesktopUpdateOperation,
  type DesktopUpdateRequest,
} from "@opensteer/protocol/maintenance";
import { HostTransportError } from "./host-transport-error.js";
import { HostTransport, type HostTransportOptions } from "./host-transport.js";
import { verifyAccessEndpoint, verifyPersonalAccessEndpoint } from "./deployment-catalog.js";

export interface DesktopUpdates {
  status(options?: { after?: string; signal?: AbortSignal }): Promise<DesktopUpdateStatus>;
  request(
    request: DesktopUpdateRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DesktopUpdateOperation>;
  subscribeWhileVisible(
    listener: (status: DesktopUpdateStatus) => void,
    options: { signal: AbortSignal; onError: (error: unknown) => void },
  ): () => void;
}
export type DesktopUpdatesFailure =
  | "unsupported"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "offline"
  | "unavailable"
  | "invalid-response";
export class DesktopUpdatesError extends Error {
  readonly reason: DesktopUpdatesFailure;
  constructor(reason: DesktopUpdatesFailure) {
    super(
      {
        unsupported: "Update Opensteer locally once to enable remote updates.",
        unauthorized: "Sign in to update this computer.",
        forbidden: "Only this computer's owner can update it.",
        conflict: "A desktop update is already in progress.",
        offline: "Could not reach this computer.",
        unavailable: "Could not read or change this computer’s updates.",
        "invalid-response": "This computer returned an invalid update response.",
      }[reason],
    );
    this.reason = reason;
  }
}

/** Own transport lifetime: usable before attachment and after an epoch refusal. */
export class DesktopUpdatesService implements DesktopUpdates {
  readonly #transport: HostTransport;
  #verifiedKey: string | null = null;
  constructor(options: HostTransportOptions) {
    this.#transport = new HostTransport(options);
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
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("Updates view closed"));
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    void (async () => {
      let after: string | undefined;
      try {
        while (!controller.signal.aborted) {
          const status = await this.status({
            ...(after === undefined ? {} : { after }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) break;
          listener(status);
          if (!status.supported) break;
          after = status.revision;
        }
      } catch (error) {
        if (!controller.signal.aborted) options.onError(error);
      } finally {
        options.signal.removeEventListener("abort", stop);
      }
    })();
    return stop;
  }
  async #verify(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const selected = await this.#transport.current();
    if (selected.resolved.key === this.#verifiedKey) return selected.resolved;
    const { connection, resolved } = selected;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const requestSignal = init?.signal ?? signal;
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== resolved.origin) throw new DesktopUpdatesError("invalid-response");
      return this.#transport.exchange(
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
    if ((await this.#transport.current()).resolved.key !== resolved.key)
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
          path: `/maintenance/v1/desktop-update${query}`,
          headers: {
            accept: "application/json",
            ...(body ? { contentType: "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: desktopUpdateLongPollMs + 5_000,
        },
        async (response, progress) => {
          if (!response.ok)
            throw new DesktopUpdatesError(
              (
                {
                  401: "unauthorized",
                  403: "forbidden",
                  404: "unsupported",
                  409: "conflict",
                } as const
              )[response.status as 401 | 403 | 404 | 409] ?? "unavailable",
            );
          const value = await readBoundedJson(response, {
            maximumBytes: desktopUpdateMaximumBytes,
            signal: progress.signal,
            onProgress: progress.onProgress,
            sizeError: () => new DesktopUpdatesError("invalid-response"),
          });
          const parsed = schema.safeParse(value);
          if (!parsed.success) throw new DesktopUpdatesError("invalid-response");
          return parsed.data;
        },
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
