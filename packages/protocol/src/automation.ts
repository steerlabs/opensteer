import type { OpensteerError } from "./errors.js";
import type { OpensteerSessionGrantKind, OpensteerSessionInfo } from "./session-info.js";
import type { OpensteerSemanticOperationName } from "./semantic.js";
import type { OpensteerProtocolVersion } from "./version.js";
import { OPENSTEER_PROTOCOL_NAME } from "./version.js";

export const opensteerAutomationOperationNames = [
  "route.register",
  "route.unregister",
  "route.resolve",
  "session.info",
  "network.stream.subscribe",
  "network.stream.unsubscribe",
] as const;

export type OpensteerAutomationOperationName =
  | OpensteerSemanticOperationName
  | (typeof opensteerAutomationOperationNames)[number];

export interface OpensteerAutomationHelloMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "hello";
  readonly sessionId: string;
  readonly grantKind: OpensteerSessionGrantKind;
}

export interface OpensteerAutomationResumeMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "resume";
  readonly sessionId: string;
}

export interface OpensteerAutomationInvokeMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "invoke";
  readonly requestId: string;
  readonly operation: OpensteerAutomationOperationName;
  readonly sentAt: number;
  readonly input?: unknown;
}

export interface OpensteerAutomationCancelMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "cancel";
  readonly requestId: string;
  readonly sentAt: number;
}

export interface OpensteerAutomationResultMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "result";
  readonly requestId: string;
  readonly operation: OpensteerAutomationOperationName;
  readonly receivedAt: number;
  readonly data: unknown;
}

export interface OpensteerAutomationErrorMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "error";
  readonly requestId?: string;
  readonly operation?: OpensteerAutomationOperationName;
  readonly receivedAt: number;
  readonly error: OpensteerError;
}

export interface OpensteerAutomationEventMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "event";
  readonly event: string;
  readonly emittedAt: number;
  readonly data: unknown;
}

export interface OpensteerAutomationPingMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "ping";
  readonly sentAt: number;
}

export interface OpensteerAutomationPongMessage {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly kind: "pong";
  readonly sentAt: number;
}

export type OpensteerAutomationClientMessage =
  | OpensteerAutomationHelloMessage
  | OpensteerAutomationResumeMessage
  | OpensteerAutomationInvokeMessage
  | OpensteerAutomationCancelMessage
  | OpensteerAutomationPingMessage;

export type OpensteerAutomationServerMessage =
  | OpensteerAutomationResultMessage
  | OpensteerAutomationErrorMessage
  | OpensteerAutomationEventMessage
  | OpensteerAutomationPongMessage;

export interface OpensteerSessionInfoResult {
  readonly session: OpensteerSessionInfo;
}
