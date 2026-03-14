import { OpensteerProtocolError } from "@opensteer/protocol";

import type { TimeoutExecutionContext, TimeoutPolicy, TimeoutResolutionInput } from "./types.js";

export async function runWithPolicyTimeout<T>(
  policy: TimeoutPolicy,
  input: TimeoutResolutionInput,
  operation: (context: TimeoutExecutionContext) => Promise<T>,
): Promise<T> {
  const budgetMs = policy.resolveTimeoutMs(input);
  if (budgetMs === undefined) {
    const controller = new AbortController();
    return operation({
      ...input,
      signal: controller.signal,
      remainingMs: () => undefined,
    });
  }

  const normalizedBudgetMs = normalizeBudgetMs(input.operation, budgetMs);
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadlineAt = startedAt + normalizedBudgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation({
        ...input,
        signal: controller.signal,
        budgetMs: normalizedBudgetMs,
        deadlineAt,
        remainingMs: () => Math.max(0, deadlineAt - Date.now()),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new OpensteerProtocolError(
              "timeout",
              `operation ${input.operation} exceeded ${String(normalizedBudgetMs)}ms timeout`,
              {
                details: {
                  policy: "timeout",
                  operation: input.operation,
                  budgetMs: normalizedBudgetMs,
                },
              },
            ),
          );
        }, normalizedBudgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function normalizeBudgetMs(operation: string, budgetMs: number): number {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error(`timeout budget for ${operation} must be a non-negative finite number`);
  }

  return budgetMs;
}
