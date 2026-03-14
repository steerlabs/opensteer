import { OpensteerProtocolError } from "@opensteer/protocol";

import type { TimeoutExecutionContext, TimeoutPolicy, TimeoutResolutionInput } from "./types.js";

class PolicyTimeoutController implements TimeoutExecutionContext {
  readonly signal: AbortSignal;
  readonly budgetMs: number | undefined;
  readonly deadlineAt: number | undefined;

  private readonly controller = new AbortController();
  private readonly abortPromise: Promise<never> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly input: TimeoutResolutionInput,
    budgetMs: number | undefined,
  ) {
    this.signal = this.controller.signal;
    this.budgetMs = budgetMs;
    this.deadlineAt = budgetMs === undefined ? undefined : Date.now() + budgetMs;

    if (budgetMs === undefined) {
      this.abortPromise = undefined;
      return;
    }

    const timeoutError = createTimeoutError(input.operation, budgetMs);
    if (budgetMs === 0) {
      this.controller.abort(timeoutError);
      this.abortPromise = Promise.reject(timeoutError);
      this.abortPromise.catch(() => undefined);
      return;
    }

    this.abortPromise = new Promise<never>((_, reject) => {
      this.timer = setTimeout(() => {
        this.controller.abort(timeoutError);
        reject(timeoutError);
      }, budgetMs);
    });
    this.abortPromise.catch(() => undefined);
  }

  get operation() {
    return this.input.operation;
  }

  remainingMs(): number | undefined {
    if (this.deadlineAt === undefined) {
      return undefined;
    }

    return Math.max(0, this.deadlineAt - Date.now());
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) {
      return;
    }

    throw this.signal.reason ?? abortError();
  }

  async runStep<T>(step: () => Promise<T>): Promise<T> {
    this.throwIfAborted();
    const stepPromise = Promise.resolve().then(step);
    const result =
      this.abortPromise === undefined
        ? await stepPromise
        : await Promise.race([stepPromise, this.abortPromise]);
    this.throwIfAborted();
    return result;
  }

  async execute<T>(operation: (context: TimeoutExecutionContext) => Promise<T>): Promise<T> {
    try {
      return await this.runStep(() => operation(this));
    } finally {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
      }
    }
  }
}

export async function runWithPolicyTimeout<T>(
  policy: TimeoutPolicy,
  input: TimeoutResolutionInput,
  operation: (context: TimeoutExecutionContext) => Promise<T>,
): Promise<T> {
  const budgetMs = policy.resolveTimeoutMs(input);
  const normalizedBudgetMs =
    budgetMs === undefined ? undefined : normalizeBudgetMs(input.operation, budgetMs);
  return new PolicyTimeoutController(input, normalizedBudgetMs).execute(operation);
}

function createTimeoutError(operation: string, budgetMs: number): OpensteerProtocolError {
  return new OpensteerProtocolError(
    "timeout",
    `operation ${operation} exceeded ${String(budgetMs)}ms timeout`,
    {
      details: {
        policy: "timeout",
        operation,
        budgetMs,
      },
    },
  );
}

function normalizeBudgetMs(operation: string, budgetMs: number): number {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error(`timeout budget for ${operation} must be a non-negative finite number`);
  }

  return budgetMs;
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
