export type PortableFsErrorCode =
  | "aborted"
  | "command_failed"
  | "control_plane_failed"
  | "invalid_input"
  | "mount_cancellation_unverified"
  | "output_limit_exceeded"
  | "protocol_error"
  | "spawn_failed"
  | "timeout";

export type PortableFsOperation =
  | "advance-renewal-fences"
  | "archive-volume"
  | "capacity"
  | "create-volume"
  | "destroy-volume"
  | "get-volume"
  | "issue-mount-grant"
  | "issue-read-session-grant"
  | "manager-health"
  | "mount"
  | "mount-check"
  | "mounts"
  | "revoke-mount-enrollment"
  | "route"
  | "umount"
  | "version"
  | "wake-volume";

export class PortableFsError extends Error {
  readonly code: PortableFsErrorCode;
  readonly operation: PortableFsOperation;
  readonly retryable: boolean;

  constructor(options: {
    readonly cause?: unknown;
    readonly code: PortableFsErrorCode;
    readonly message: string;
    readonly operation: PortableFsOperation;
    readonly retryable?: boolean;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "PortableFsError";
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
  }
}

export class PortableFsCommandError extends PortableFsError {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(options: {
    readonly argv: readonly string[];
    readonly cause?: unknown;
    readonly code?: "command_failed" | "spawn_failed";
    readonly exitCode: number | null;
    readonly operation: PortableFsOperation;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }) {
    const summary = options.stderr.trim().slice(0, 512);
    super({
      cause: options.cause,
      code: options.code ?? "command_failed",
      message:
        summary.length > 0
          ? `PortableFS ${options.operation} failed: ${summary}`
          : `PortableFS ${options.operation} failed`,
      operation: options.operation,
      retryable: options.code === "spawn_failed" || options.exitCode === null,
    });
    this.name = "PortableFsCommandError";
    this.argv = [...options.argv];
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.stderr = options.stderr;
  }
}

export class PortableFsTimeoutError extends PortableFsError {
  readonly timeoutMs: number;

  constructor(operation: PortableFsOperation, timeoutMs: number) {
    super({
      code: "timeout",
      message: `PortableFS ${operation} timed out after ${timeoutMs}ms`,
      operation,
      retryable: true,
    });
    this.name = "PortableFsTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class PortableFsAbortError extends PortableFsError {
  constructor(operation: PortableFsOperation) {
    super({
      code: "aborted",
      message: `PortableFS ${operation} was aborted`,
      operation,
      retryable: true,
    });
    this.name = "PortableFsAbortError";
  }
}

export class PortableFsOutputLimitError extends PortableFsError {
  readonly maxOutputBytes: number;

  constructor(operation: PortableFsOperation, maxOutputBytes: number) {
    super({
      code: "output_limit_exceeded",
      message: `PortableFS ${operation} exceeded the ${maxOutputBytes}-byte output limit`,
      operation,
    });
    this.name = "PortableFsOutputLimitError";
    this.maxOutputBytes = maxOutputBytes;
  }
}

/**
 * A mount was canceled, but current upstream PortableFS could not provide an
 * identity-safe cancellation/absence proof. Callers must fence or reconcile
 * this runner before reusing the workspace.
 */
export class PortableFsMountCancellationUnverifiedError extends PortableFsError {
  readonly requestedStop: "aborted" | "output-limit" | "timeout";
  readonly upstreamPrerequisite = "portablefs-identity-safe-mount-cancel" as const;

  constructor(options: {
    readonly cause: unknown;
    readonly requestedStop: "aborted" | "output-limit" | "timeout";
  }) {
    super({
      cause: options.cause,
      code: "mount_cancellation_unverified",
      message:
        "PortableFS mount cancellation could not prove the mount absent; fence or reconcile the runner before reuse",
      operation: "mount",
    });
    this.name = "PortableFsMountCancellationUnverifiedError";
    this.requestedStop = options.requestedStop;
  }
}

export class PortableFsProtocolError extends PortableFsError {
  constructor(options: {
    readonly cause?: unknown;
    readonly message: string;
    readonly operation: PortableFsOperation;
  }) {
    super({
      cause: options.cause,
      code: "protocol_error",
      message: options.message,
      operation: options.operation,
    });
    this.name = "PortableFsProtocolError";
  }
}

export class PortableFsControlPlaneError extends PortableFsError {
  readonly httpStatus: number | undefined;
  readonly remoteCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(options: {
    readonly cause?: unknown;
    readonly httpStatus?: number;
    readonly message: string;
    readonly operation: PortableFsOperation;
    readonly remoteCode?: string;
    readonly requestId?: string;
    readonly retryable?: boolean;
  }) {
    super({
      cause: options.cause,
      code: "control_plane_failed",
      message: options.message,
      operation: options.operation,
      retryable: options.retryable ?? false,
    });
    this.name = "PortableFsControlPlaneError";
    this.httpStatus = options.httpStatus;
    this.remoteCode = options.remoteCode;
    this.requestId = options.requestId;
  }
}

export class PortableFsRenewalScopeFencedError extends PortableFsControlPlaneError {
  constructor(options: {
    readonly message: string;
    readonly operation: PortableFsOperation;
    readonly requestId?: string;
  }) {
    super({
      httpStatus: 409,
      message: options.message,
      operation: options.operation,
      remoteCode: "renewal_scope_fenced",
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    this.name = "PortableFsRenewalScopeFencedError";
  }
}

const tokenPatterns: readonly RegExp[] = [
  /\bBearer\s+[^\s,;]+/giu,
  /\bPORTABLEFS_MOUNT_TOKEN\s*=\s*[^\s,;]+/giu,
  /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |RSA )?PRIVATE KEY-----/gu,
];

/** Redacts explicitly supplied secrets plus known credential wire formats. */
export function redactSensitiveText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  const uniqueSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of uniqueSecrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  for (const pattern of tokenPatterns) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith("bearer")) return "Bearer [REDACTED]";
      if (match.toUpperCase().startsWith("PORTABLEFS_MOUNT_TOKEN")) {
        return "PORTABLEFS_MOUNT_TOKEN=[REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}
