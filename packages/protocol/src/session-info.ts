import type { PageRef } from "./identity.js";
import type { OpensteerSemanticOperationName } from "./semantic.js";
import type { OpensteerCapability } from "./capabilities.js";
import type { OpensteerProtocolVersion } from "./version.js";

export const opensteerSessionGrantKinds = ["semantic", "automation", "view", "cdp"] as const;

export type OpensteerSessionGrantKind = (typeof opensteerSessionGrantKinds)[number];
export type OpensteerSessionGrantTransport = "http" | "ws";
export type OpensteerProviderMode = "local" | "cloud";
export type OpensteerSessionOwnership = "owned" | "attached" | "managed";

export interface OpensteerProviderDescriptor {
  readonly mode: OpensteerProviderMode;
  readonly ownership: OpensteerSessionOwnership;
  readonly engine?: string;
  readonly baseUrl?: string;
  readonly region?: string;
}

export interface OpensteerSessionCapabilities {
  readonly semanticOperations: readonly OpensteerSemanticOperationName[];
  readonly protocolCapabilities?: readonly OpensteerCapability[];
  readonly sessionGrants?: readonly OpensteerSessionGrantKind[];
  readonly instrumentation: {
    readonly route: boolean;
    readonly interceptScript: boolean;
    readonly networkStream: boolean;
  };
}

export interface OpensteerSessionGrant {
  readonly kind: OpensteerSessionGrantKind;
  readonly transport: OpensteerSessionGrantTransport;
  readonly url: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface OpensteerSessionAccessGrantResponse {
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly grants: Partial<Record<OpensteerSessionGrantKind, OpensteerSessionGrant>>;
}

export interface OpensteerRuntimeVersionInfo {
  readonly protocolVersion: OpensteerProtocolVersion;
  readonly runtimeCoreVersion?: string;
  readonly packages?: Readonly<Record<string, string>>;
}

export interface OpensteerSessionInfo {
  readonly provider: OpensteerProviderDescriptor;
  readonly workspace?: string;
  readonly sessionId?: string;
  readonly activePageRef?: PageRef;
  readonly reconnectable: boolean;
  readonly capabilities: OpensteerSessionCapabilities;
  readonly grants?: readonly OpensteerSessionGrant[];
  readonly runtime?: OpensteerRuntimeVersionInfo;
}
