import { OpensteerError, refused } from "@opensteer/core";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import type { z } from "zod";

type Service = "Account" | "Cloudflare" | "Google metadata" | "Google Compute Engine" | "Home";
export interface HttpOptions {
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly maximumResponseBytes?: number;
}

export class RemoteRequestError extends OpensteerError {
  readonly service: Service;
  readonly status: number;
  readonly retryAt: number | undefined;
  /** Error reasons the service named in its error body, when the caller asked to read it. */
  readonly reasons: readonly string[];

  constructor(service: Service, status: number, retryAt?: number, reasons: readonly string[] = []) {
    super({
      code:
        status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : status === 404
              ? "not_found"
              : status === 409
                ? "conflict"
                : status === 429
                  ? "resource_exhausted"
                  : "internal",
      message: `${service} request returned HTTP ${status}`,
    });
    this.service = service;
    this.status = status;
    this.retryAt = retryAt;
    this.reasons = reasons;
  }
}

/** A provider refused for its rate quota. The work is retried later; nothing failed. */
export class ProviderRateLimited extends Error {
  readonly retryAt: number;
  constructor(retryAt: number, cause?: unknown) {
    super("The provider rate limit was reached", { cause });
    this.retryAt = retryAt;
  }
}

export class ProviderWriteRejected extends Error {
  readonly original: Error;
  constructor(original: Error) {
    super(original.message);
    this.original = original;
  }
}

export class ProviderOutcomeUnknown extends Error {
  constructor(cause?: unknown) {
    super("The provider operation outcome is unknown", { cause });
  }
}

export async function confirmProviderAcceptance<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof RemoteRequestError && error.status >= 400 && error.status < 500)
      throw new ProviderWriteRejected(error);
    throw error;
  }
}

export async function request<T>(
  service: Service,
  url: URL,
  options: HttpOptions,
  shutdown: AbortSignal,
  decode: (text: string) => T,
  input: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** Read the reasons from a Google `google.rpc.Status` error body (AIP-193). */
    errorReasons?: boolean;
  } = {},
): Promise<T> {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(options.timeoutMs)]);
  const { method = "GET", body, headers, errorReasons = false } = input;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method,
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw requestFailure(service, signal, "request failed");
  }

  if (!response.ok) {
    const reasons = errorReasons ? await readErrorReasons(response, signal) : [];
    if (!errorReasons) void response.body?.cancel().catch(() => undefined);
    throw new RemoteRequestError(
      service,
      response.status,
      response.status === 429 ? retryAt(response.headers) : undefined,
      reasons,
    );
  }

  try {
    const bytes = await readBoundedResponse(response, {
      maximumBytes: options.maximumResponseBytes ?? 1024 * 1024,
      signal,
    });
    return decode(new TextDecoder().decode(bytes));
  } catch {
    throw requestFailure(service, signal, "returned an invalid response");
  }
}

async function readErrorReasons(response: Response, signal: AbortSignal): Promise<string[]> {
  try {
    const bytes = await readBoundedResponse(response, { maximumBytes: 64 * 1024, signal });
    const error = (JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown }).error;
    if (!error || typeof error !== "object") return [];
    const entries = [
      ...(Array.isArray((error as { errors?: unknown }).errors)
        ? ((error as { errors: unknown[] }).errors as unknown[])
        : []),
      ...(Array.isArray((error as { details?: unknown }).details)
        ? ((error as { details: unknown[] }).details as unknown[])
        : []),
    ];
    return entries.flatMap((entry) => {
      const reason = (entry as { reason?: unknown } | null)?.reason;
      return typeof reason === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(reason) ? [reason] : [];
    });
  } catch {
    void response.body?.cancel().catch(() => undefined);
    return [];
  }
}

export function json<T>(schema: z.ZodType<T>): (text: string) => T {
  return (text) => schema.parse(JSON.parse(text));
}

function requestFailure(service: Service, signal: AbortSignal, message: string) {
  return signal.aborted
    ? refused("timeout", `${service} request was cancelled or timed out`)
    : refused("internal", `${service} ${message}`);
}

function retryAt(headers: Headers): number {
  const now = Date.now();
  const retry = headers.get("retry-after");
  const reset = headers.get("ratelimit-reset");
  if (retry !== null) {
    const timestamp = /^\d+$/u.test(retry) ? now + Number(retry) * 1_000 : Date.parse(retry);
    if (Number.isFinite(timestamp)) return Math.max(timestamp, now);
  }
  if (reset !== null && /^\d{1,12}$/u.test(reset)) {
    return Math.max(Number(reset) * 1_000, now);
  }
  return now + 1_000;
}

export class BootstrapScrubFailure extends Error {
  constructor(cause?: unknown) {
    super("Could not confirm removal of bootstrap metadata", { cause });
  }
}

export class ProviderPlacementError extends Error {}

export class UntrackedPoolProfileDiskError extends Error {
  readonly diskName: string;
  readonly hostId: string;
  constructor(diskName: string, hostId: string) {
    super(
      `Pool profile disk ${diskName} of ${hostId} is not tracked by Account. ` +
        "The orphan sweep never deletes durable profile disks; inspect and delete manually if intended.",
    );
    this.diskName = diskName;
    this.hostId = hostId;
  }
}

export function provisionerFailure(error: unknown) {
  if (error instanceof ProviderPlacementError)
    return { event: "home-provisioner.provider.wrong-zone", message: error.message };
  if (error instanceof UntrackedPoolProfileDiskError)
    return {
      event: "home-provisioner.pool.untracked-profile-disk",
      diskName: error.diskName,
      hostId: error.hostId,
      message: error.message,
    };
  if (error instanceof BootstrapScrubFailure)
    return { event: "home-provisioner.provider.bootstrap-scrub-failed" };
  if (error instanceof ProviderOutcomeUnknown)
    return { event: "home-provisioner.provider.outcome-unknown" };
  if (error instanceof ProviderRateLimited)
    return { event: "home-provisioner.provider.rate-limited", retryAt: error.retryAt };
  if (error instanceof ProviderWriteRejected && error.original instanceof RemoteRequestError)
    return provisionerFailure(error.original);
  if (!(error instanceof RemoteRequestError)) return { event: "home-provisioner.pass.failed" };
  const { service, status, retryAt, reasons } = error;
  const event =
    service === "Account" && (status === 401 || status === 403)
      ? "home-provisioner.account.refused"
      : service === "Account" && status === 409
        ? "home-provisioner.lease.conflict"
        : status === 429
          ? "home-provisioner.provider.rate-limited"
          : "home-provisioner.pass.failed";
  return { event, service, status, retryAt, ...(reasons.length ? { reasons } : {}) };
}
