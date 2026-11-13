import { createHttpHostApiClient } from "@opensteer/client/host-api";
import type { HostApiClient, RpcResult } from "@opensteer/protocol";

export type DesktopHostFetch = (input: URL | RequestInfo, init: RequestInit) => Promise<Response>;

/** A Host's refusal or an unreachable Host, with the contract's code and reason kept. */
export class DesktopHostApiError extends Error {
  readonly code: string;
  readonly reason: string | undefined;
  readonly retryable: boolean;

  constructor(error: {
    readonly code: string;
    readonly message: string;
    readonly reason?: string | undefined;
    readonly retryable: boolean;
  }) {
    super(error.message);
    this.name = "DesktopHostApiError";
    this.code = error.code;
    this.reason = error.reason;
    this.retryable = error.retryable;
  }
}

export function hostApiData<Success>(
  result: RpcResult<
    Success,
    {
      readonly code: string;
      readonly message: string;
      readonly reason?: string | undefined;
      readonly retryable: boolean;
    }
  >,
): Success {
  if (result.ok) return result.data;
  throw new DesktopHostApiError(result.error);
}

/**
 * Desktop main's only way to call a Host's typed API. The shared client owns
 * the route, method, input encoding, version header and response schemas, so a
 * call here cannot drift from the declaration the Host serves. `fetch` supplies
 * the Deployment's cookie partition; the Host's CSRF check wants the Origin.
 */
export function createDesktopHostApi(options: {
  readonly origin: string;
  readonly fetch: DesktopHostFetch;
}): HostApiClient {
  const origin = new URL(options.origin).origin;
  return createHttpHostApiClient({
    baseUrl: new URL(origin),
    kind: "personal",
    fetch: (input, init) =>
      options.fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), origin },
      }),
    onAuthenticationRequired: () => undefined,
  });
}
