/** A refused or failed call, as its caller should read it. */
export interface AgentToolFailure {
  readonly machineId?: string | undefined;
  readonly capability?: "browser" | "apps" | "files" | undefined;
  readonly code: string;
  readonly message: string;
  /** What to do about it, naming the tool and parameter. */
  readonly next?: string | undefined;
  readonly reason?: string | undefined;
  readonly retryable: boolean;
}

/**
 * Engines read different halves of a result: Codex shows its model only
 * `structuredContent` when there is any, and Pi only `content`. Whatever a
 * model must read goes in both.
 */
export function agentToolFailureResult(failure: AgentToolFailure) {
  const device =
    failure.machineId && failure.capability
      ? `${failure.reason ?? failure.code}: machineId=${failure.machineId}, capability=${failure.capability}.`
      : undefined;
  const text = [
    device,
    failure.message,
    failure.next ?? (failure.retryable ? "Try again." : undefined),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      error: {
        ...(failure.machineId === undefined ? {} : { machineId: failure.machineId }),
        ...(failure.capability === undefined ? {} : { capability: failure.capability }),
        code: failure.code,
        message: text,
        ...(failure.reason === undefined ? {} : { reason: failure.reason }),
        retryable: failure.retryable,
      },
    },
    isError: true,
  };
}

export function agentToolRecordResult(result: Record<string, unknown>, guidance?: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result) },
      ...(guidance ? [{ type: "text" as const, text: guidance }] : []),
    ],
    structuredContent: guidance ? { ...result, guidance } : result,
    ...(result.isError === true ? { isError: true } : {}),
  };
}
