import { OpensteerError } from "@opensteer/core";
import { Deferred } from "./deferred.js";
import type { HarnessAuthenticationResult, HarnessAuthenticationStart } from "./types.js";

export interface SecretInputAuthenticationOptions {
  /** How the flow settles when the person walked away without entering one. */
  readonly cancelledDetail: string;
  /** The engine's own name, for the refusal a late submission gets. */
  readonly engineLabel: string;
  readonly inputLabel: string;
  readonly inputPlaceholder?: string;
  /** Longest secret this provider will accept. */
  readonly maximumLength?: number;
  /** The refusal an empty or oversized field gets. */
  readonly requiredMessage: string;
  /** How the flow settles when the secret could not be written. */
  readonly storeFailedDetail: string;
  /** Abandoning the request that opened the flow cancels it. */
  readonly signal?: AbortSignal;
  /** Writes the secret where the driver keeps it. Never told anything else. */
  readonly store: (secret: string) => Promise<void>;
}

/**
 * A sign-in that is one secret the person pastes: there is nothing to start
 * and nothing to poll, so the flow exists only to carry the value once, from
 * the Host to the Runner, into the place the driver names.
 *
 * The result promise is the whole outcome. A write that fails settles it as
 * failed rather than leaving the flow pending, because a `submit` that only
 * threw would leave the account waiting for a completion that can never come.
 */
export function secretInputAuthentication(
  options: SecretInputAuthenticationOptions,
): HarnessAuthenticationStart {
  const outcome = new Deferred<HarnessAuthenticationResult>();
  let settled = false;
  const finish = (result: HarnessAuthenticationResult) => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", abort);
    outcome.resolve(result);
  };
  const abort = () => finish({ detail: options.cancelledDetail, status: "failed" });
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  return {
    cancel: async () => finish({ detail: options.cancelledDetail, status: "failed" }),
    challenge: {
      inputLabel: options.inputLabel,
      ...(options.inputPlaceholder ? { inputPlaceholder: options.inputPlaceholder } : {}),
      kind: "secret-input",
    },
    result: outcome.promise,
    status: "pending",
    submit: async (value) => {
      if (settled) {
        throw new OpensteerError({
          code: "conflict",
          message: `${options.engineLabel} setup is no longer pending`,
        });
      }
      const secret = value.trim();
      if (
        secret.length === 0 ||
        (options.maximumLength !== undefined && secret.length > options.maximumLength)
      ) {
        throw new OpensteerError({ code: "bad_request", message: options.requiredMessage });
      }
      try {
        await options.store(secret);
      } catch {
        finish({ detail: options.storeFailedDetail, status: "failed" });
        return;
      }
      finish({ status: "ready" });
    },
  };
}
