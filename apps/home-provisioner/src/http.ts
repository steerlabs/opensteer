import { OpensteerError, refused } from "@opensteer/core";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import type { z } from "zod";

type Service = "Account" | "Hetzner" | "Cloudflare" | "Google metadata" | "Home";
export interface HttpOptions {
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly maximumResponseBytes?: number;
}

export class RemoteRequestError extends OpensteerError {
  readonly service: Service;
  readonly status: number;
  readonly retryAt: number | undefined;

  constructor(service: Service, status: number, retryAt?: number) {
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
  }
}

export async function request<T>(
  service: Service,
  url: URL,
  options: HttpOptions,
  shutdown: AbortSignal,
  decode: (text: string) => T,
  input: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(options.timeoutMs)]);
  const { method = "GET", body, headers } = input;
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
    void response.body?.cancel().catch(() => undefined);
    throw new RemoteRequestError(
      service,
      response.status,
      response.status === 429 ? retryAt(response.headers) : undefined,
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

export function provisionerFailure(error: unknown) {
  if (!(error instanceof RemoteRequestError)) return { event: "home-provisioner.pass.failed" };
  const { service, status, retryAt } = error;
  const event =
    service === "Account" && (status === 401 || status === 403)
      ? "home-provisioner.account.refused"
      : service === "Account" && status === 409
        ? "home-provisioner.lease.conflict"
        : status === 429
          ? "home-provisioner.provider.rate-limited"
          : "home-provisioner.pass.failed";
  return { event, service, status, retryAt };
}
