import {
  HostNotificationPublicationResponseSchema,
  HostNotificationPublicationSchema,
  type HostNotificationPublication,
} from "@opensteer/control-plane-protocol";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import type { NotificationPublication } from "@opensteer/database";
import type { DeploymentId, HostInstanceId } from "@opensteer/core";
import { z } from "zod";
import { buildMobileThreadDeepLink } from "@opensteer/core";
import type { NotificationPreviewService } from "./notification-preview-service.js";
import { sealNotificationPreview } from "./notification-preview.js";

const maximumResponseBytes = 4 * 1_024;

/**
 * Where this Host's Account channel currently is. An attached server Host
 * reads it from configuration once; a Personal Host reads it from the link row,
 * which can be removed while the process runs, so it is resolved per attempt
 * rather than captured.
 */
export interface NotificationPublicationTarget {
  readonly controlApiOrigin: URL;
  readonly hostCredential: string;
}

export interface NotificationPublicationClientOptions {
  readonly previews?: Pick<NotificationPreviewService, "keys">;
  readonly deploymentId: DeploymentId;
  readonly fetch?: typeof globalThis.fetch;
  readonly hostInstanceId: HostInstanceId;
  readonly target: () => Promise<NotificationPublicationTarget | null>;
}

export type NotificationPublicationResult =
  | { readonly status: "published" }
  | { readonly status: "no-target" }
  | { readonly status: "push-not-configured" }
  | { readonly status: "retry"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export class NotificationPublicationClient {
  readonly #previews: NotificationPublicationClientOptions["previews"];
  readonly #deploymentId: DeploymentId;
  readonly #fetch: typeof globalThis.fetch;
  readonly #hostInstanceId: HostInstanceId;
  readonly #target: NotificationPublicationClientOptions["target"];

  constructor(options: NotificationPublicationClientOptions) {
    this.#previews = options.previews;
    this.#deploymentId = options.deploymentId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#hostInstanceId = options.hostInstanceId;
    this.#target = options.target;
  }

  async publish(input: {
    readonly entry: NotificationPublication;
    readonly recipientAccountIds: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<NotificationPublicationResult> {
    const { entry } = input;
    const target = await this.#target();
    if (!target) return { status: "no-target" };
    input.signal.throwIfAborted();
    const deepLink = buildMobileThreadDeepLink({
      deploymentId: this.#deploymentId,
      threadId: entry.threadId,
      messageId: entry.kind === "reply-published" ? entry.messageId : null,
      requestId: entry.kind === "request-opened" ? entry.requestId : null,
    });
    const keys = (await this.#previews?.keys(entry.userId, input.recipientAccountIds)) ?? [];
    const previews = keys.map((key) => ({
      accountId: key.accountId,
      installationId: key.installationId,
      preview: sealNotificationPreview({
        key: key.key,
        plaintext: { version: 1, title: entry.title, body: entry.body },
        context: {
          deploymentId: this.#deploymentId,
          notificationId: entry.id,
          installationId: key.installationId,
          keyId: key.keyId,
          kind: entry.kind,
          deepLink,
          expiresAt: entry.expiresAt.toISOString(),
        },
      }),
    }));
    input.signal.throwIfAborted();
    const request: HostNotificationPublication = HostNotificationPublicationSchema.parse({
      deploymentId: this.#deploymentId,
      eventId: entry.eventId,
      expiresAt: entry.expiresAt.toISOString(),
      hostInstanceId: this.#hostInstanceId,
      kind: entry.kind,
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      notificationId: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
      recipientAccountIds: input.recipientAccountIds,
      ...(previews.length ? { previews } : {}),
      requestId: entry.requestId,
      runId: entry.runId,
      schemaVersion: 1,
      sequence: entry.sequence,
      threadId: entry.threadId,
      workspaceId: entry.workspaceId,
    });
    const url = new URL("/v1/host/notifications", exactOrigin(target.controlApiOrigin));
    const authorization = `Bearer ${hostCredential(target.hostCredential)}`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15_000);
    timer.unref();
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          body: JSON.stringify(request),
          headers: {
            accept: "application/json",
            authorization,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "manual",
          signal,
        });
      } catch {
        input.signal.throwIfAborted();
        return { status: "retry", reason: "Notification publication API request failed" };
      }
      if (!response.ok) {
        if (await pushNotConfigured(response, signal)) return { status: "push-not-configured" };
        return {
          status: response.status === 429 || response.status >= 500 ? "retry" : "failed",
          reason: `Notification publication API returned HTTP ${response.status}`,
        };
      }
      try {
        const acknowledged = HostNotificationPublicationResponseSchema.parse(
          await readBoundedJson(response, { ...boundedJsonOptions, signal }),
        );
        if (acknowledged.notificationId !== request.notificationId)
          throw new Error("Mismatched notification");
      } catch (error) {
        input.signal.throwIfAborted();
        if (timeout.signal.aborted)
          return { status: "retry", reason: "Notification publication API request timed out" };
        if (error instanceof TypeError)
          return { status: "retry", reason: "Notification publication API request failed" };
        return {
          status: "failed",
          reason: "Notification publication API returned an invalid acknowledgement",
        };
      }
      return { status: "published" };
    } finally {
      clearTimeout(timer);
    }
  }
}

const AccountErrorSchema = z.object({
  error: z.object({ reason: z.string().max(120).optional() }),
});

async function pushNotConfigured(response: Response, signal: AbortSignal): Promise<boolean> {
  if (response.status !== 404) {
    await response.body?.cancel();
    return false;
  }
  try {
    const body = AccountErrorSchema.safeParse(
      await readBoundedJson(response, { ...boundedJsonOptions, signal }),
    );
    return body.success && body.data.error.reason === "push-not-configured";
  } catch {
    return false;
  }
}

function exactOrigin(input: URL): URL {
  const url = new URL(input.toString());
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Notification control API must be an uncredentialed HTTP(S) origin");
  }
  return url;
}

function hostCredential(value: string): string {
  if (!/^osc_[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Notification publication Host credential is invalid");
  }
  return value;
}

const boundedJsonOptions = {
  emptyError: () => new Error("Notification publication API returned an empty response"),
  invalidJsonError: (cause: unknown) =>
    new Error("Notification publication API returned invalid JSON", { cause }),
  maximumBytes: maximumResponseBytes,
  sizeError: () => new Error("Notification publication API response exceeded its size limit"),
} as const;
