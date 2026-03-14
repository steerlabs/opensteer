import type { SettleContext, SettlePolicy } from "./types.js";

export async function settleWithPolicy(policy: SettlePolicy, input: SettleContext): Promise<void> {
  for (const observer of policy.observers ?? []) {
    if (await observer.settle(input)) {
      return;
    }
  }

  const delayMs = policy.resolveDelayMs({
    operation: input.operation,
    trigger: input.trigger,
  });
  if (delayMs <= 0) {
    return;
  }

  await delayWithSignal(delayMs, input.signal);
}

export function delayWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? abortError());
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
