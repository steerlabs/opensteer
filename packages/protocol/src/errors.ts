import type { OpensteerCapability } from "./capabilities.js";
import { opensteerCapabilitySchema } from "./capabilities.js";
import { objectSchema, recordSchema, stringSchema, type JsonSchema } from "./json.js";

export const opensteerErrorCodes = [
  "invalid-request",
  "invalid-argument",
  "invalid-ref",
  "unsupported-version",
  "unsupported-operation",
  "unsupported-capability",
  "not-found",
  "stale-node-ref",
  "session-closed",
  "page-closed",
  "frame-detached",
  "timeout",
  "navigation-failed",
  "permission-denied",
  "conflict",
  "profile-unavailable",
  "auth-failure",
  "auth-recovery-failed",
  "browser-required",
  "rate-limited",
  "operation-failed",
  "internal",
] as const;

export type OpensteerErrorCode = (typeof opensteerErrorCodes)[number];

export interface OpensteerError {
  readonly code: OpensteerErrorCode;
  readonly message: string;
  readonly retriable: boolean;
  readonly capability?: OpensteerCapability;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface OpensteerErrorOptions {
  readonly cause?: unknown;
  readonly retriable?: boolean;
  readonly capability?: OpensteerCapability;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class OpensteerProtocolError extends Error {
  readonly code: OpensteerErrorCode;
  readonly retriable: boolean;
  readonly capability: OpensteerCapability | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: OpensteerErrorCode, message: string, options: OpensteerErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "OpensteerProtocolError";
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.capability = options.capability;
    this.details = options.details;
  }
}

export function createOpensteerError(
  code: OpensteerErrorCode,
  message: string,
  options: Omit<OpensteerErrorOptions, "cause"> = {},
): OpensteerError {
  return {
    code,
    message,
    retriable: options.retriable ?? false,
    ...(options.capability === undefined ? {} : { capability: options.capability }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

export function unsupportedCapabilityError(capability: OpensteerCapability): OpensteerError {
  return createOpensteerError(
    "unsupported-capability",
    `capability ${capability} is not supported by this surface`,
    {
      capability,
      details: { capability },
    },
  );
}

export function isOpensteerProtocolError(value: unknown): value is OpensteerProtocolError {
  return value instanceof OpensteerProtocolError;
}

export function toOpensteerError(
  error: Pick<
    OpensteerProtocolError | OpensteerError,
    "code" | "message" | "retriable" | "capability" | "details"
  >,
): OpensteerError {
  return createOpensteerError(error.code, error.message, {
    retriable: error.retriable,
    ...(error.capability === undefined ? {} : { capability: error.capability }),
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export function unsupportedVersionError(version: string): OpensteerError {
  return createOpensteerError(
    "unsupported-version",
    `protocol version ${version} is not supported`,
    {
      details: { version },
    },
  );
}

export const opensteerErrorCodeSchema: JsonSchema = {
  title: "OpensteerErrorCode",
  enum: opensteerErrorCodes,
};

export const opensteerErrorSchema: JsonSchema = objectSchema(
  {
    code: opensteerErrorCodeSchema,
    message: stringSchema(),
    retriable: {
      type: "boolean",
    },
    capability: opensteerCapabilitySchema,
    details: recordSchema({}),
  },
  {
    title: "OpensteerError",
    required: ["code", "message", "retriable"],
  },
);

export function httpStatusForOpensteerError(error: OpensteerError): number {
  switch (error.code) {
    case "invalid-request":
    case "invalid-argument":
    case "invalid-ref":
    case "unsupported-version":
      return 400;
    case "permission-denied":
      return 403;
    case "not-found":
    case "stale-node-ref":
    case "session-closed":
    case "page-closed":
    case "frame-detached":
      return 404;
    case "conflict":
    case "profile-unavailable":
    case "auth-failure":
    case "auth-recovery-failed":
      return 409;
    case "browser-required":
      return 412;
    case "rate-limited":
      return 429;
    case "unsupported-operation":
    case "unsupported-capability":
      return 501;
    case "timeout":
      return 504;
    case "navigation-failed":
    case "operation-failed":
      return 502;
    case "internal":
      return 500;
  }

  return 500;
}
