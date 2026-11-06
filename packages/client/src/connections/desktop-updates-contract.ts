import type { z } from "zod";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import {
  DesktopUpdateOperationSchema,
  DesktopUpdateRequestSchema,
  DesktopUpdateStatusSchema,
  desktopUpdateLongPollMs,
  desktopUpdateMaximumBytes,
  type DesktopUpdateOperation,
  type DesktopUpdateRequest,
  type DesktopUpdateStatus,
} from "@opensteer/protocol/maintenance";

export const desktopUpdatePath = "/maintenance/v1/desktop-update";
export const desktopUpdateRequestTimeoutMs = desktopUpdateLongPollMs + 5_000;

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

export async function readDesktopUpdateResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  progress: { readonly signal?: AbortSignal; readonly onProgress?: () => void },
): Promise<T> {
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
  // A Host older than this contract answers an unknown GET with its web app's index.html.
  if (/^text\/html\b/iu.test(response.headers.get("content-type") ?? ""))
    throw new DesktopUpdatesError("unsupported");
  const value = await readBoundedJson(response, {
    maximumBytes: desktopUpdateMaximumBytes,
    ...(progress.signal === undefined ? {} : { signal: progress.signal }),
    ...(progress.onProgress === undefined ? {} : { onProgress: progress.onProgress }),
    sizeError: () => new DesktopUpdatesError("invalid-response"),
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DesktopUpdatesError("invalid-response");
  return parsed.data;
}

export function followDesktopUpdates(
  updates: Pick<DesktopUpdates, "status">,
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
        const status = await updates.status({
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

/** A page its Host served: the origin is already that Host, and its cookie is the session. */
export class OriginDesktopUpdates implements DesktopUpdates {
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  constructor(origin: string, fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#origin = origin;
    this.#fetch = fetch;
  }
  status(options: { after?: string; signal?: AbortSignal } = {}): Promise<DesktopUpdateStatus> {
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
  async #exchange<T>(
    method: "GET" | "POST",
    query: string,
    body: DesktopUpdateRequest | undefined,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(desktopUpdateRequestTimeoutMs);
    const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    try {
      const response = await this.#fetch(`${this.#origin}${desktopUpdatePath}${query}`, {
        method,
        cache: "no-store",
        credentials: "include",
        redirect: "error",
        signal: bounded,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return await readDesktopUpdateResponse(response, schema, { signal: bounded });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DesktopUpdatesError) throw error;
      throw new DesktopUpdatesError(deadline.aborted ? "unavailable" : "offline");
    }
  }
}
