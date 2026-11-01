import type {
  HarnessCapabilities,
  HarnessProcessLaunch,
  HarnessSessionContext,
} from "@opensteer/harness";
import type { OpensteerError, PendingRequest, ThreadAccessMode } from "@opensteer/core";

export type AcpProtocolVersion = 1 | 2;

export interface AcpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface AcpClientCapabilities {
  readonly elicitation: boolean;
  readonly fileSystem: "none" | "read-only";
  readonly terminal: false;
}

export type AcpResumePolicy =
  | { readonly method: "load"; readonly suppressReplay: true }
  | { readonly method: "resume"; readonly suppressReplay: false };

export type AcpCancelPolicy =
  | {
      readonly behavior: "cancel-and-kill";
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly behavior: "wait-for-prompt";
      readonly metadata?: Readonly<Record<string, unknown>>;
    };

/** Protocol behavior that is stable for one concrete engine integration. */
export interface AcpSessionPolicy {
  readonly protocolVersion: AcpProtocolVersion;
  readonly clientInfo: AcpClientInfo;
  readonly clientCapabilities: AcpClientCapabilities;
  readonly initializeDeadlineMs: number;
  readonly eagerAuthentication: boolean;
  readonly resume: AcpResumePolicy;
  readonly cancel: AcpCancelPolicy;
  readonly initializeMetadata?: Readonly<Record<string, unknown>>;
  readonly accessModeIds: Readonly<Record<ThreadAccessMode, string>>;
  readonly model:
    | {
        readonly type: "set-model";
        readonly effortOptionId?: string;
        readonly effortMetadataKey?: string;
      }
    | {
        readonly type: "config-options";
        readonly modelCategory: "model";
        readonly effortCategory: "thought_level";
        readonly effortOptionId: string;
      };
}

export interface AcpPermissionOption {
  readonly description?: string;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

export interface AcpPermissionRequest {
  readonly options: readonly AcpPermissionOption[];
  readonly sessionId?: string;
  readonly toolCall: AcpToolCall;
}

export interface AcpToolCall {
  readonly content?: readonly unknown[];
  readonly id: string;
  readonly kind?: string;
  readonly locations?: readonly { readonly path?: string }[];
  readonly name?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly status?: string;
  readonly title?: string;
}

export interface AcpPermissionChoice {
  readonly description?: string;
  readonly hint: "allow-once" | "allow-for-run" | "reject-once" | "cancel" | "other";
  readonly optionId: string;
  readonly label: string;
}

export type AcpNormalizedUpdate =
  | { readonly kind: "assistant"; readonly messageId?: string; readonly text: string }
  | { readonly kind: "thought"; readonly messageId?: string; readonly text: string }
  | { readonly kind: "tool"; readonly toolCall: AcpToolCall }
  | {
      readonly kind: "subagent";
      readonly key: string;
      readonly state: "started" | "completed" | "failed";
      readonly model?: string;
      readonly prompt?: string;
      readonly result?: string;
      readonly sessionReference?: string;
      readonly title?: string;
    }
  | {
      readonly kind: "usage";
      readonly cachedInputTokens?: number;
      readonly cacheWriteTokens?: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly reasoningTokens?: number;
    }
  | { readonly kind: "ignore" };

export interface AcpErrorContext {
  readonly operation: "initialize" | "authenticate" | "new" | "resume" | "prompt" | "cancel";
  readonly stderrTail: string;
}

export interface AcpNativeHooks {
  /** Engine-specific extensions and quirks only; standard ACP updates are normalized first. */
  normalizeUpdate?(update: unknown): readonly AcpNormalizedUpdate[] | undefined;
  classifyError(error: unknown, context: AcpErrorContext): OpensteerError;
  permissionChoices(request: AcpPermissionRequest): readonly AcpPermissionChoice[];
  authenticationMethod?(
    context: HarnessSessionContext,
    inspection: AcpInspectionSnapshot,
  ): string | undefined;
  rewritePromptText?(text: string, context: HarnessSessionContext): Promise<string> | string;
}

export interface AcpLaunchOptions {
  readonly accessMode: ThreadAccessMode;
  readonly context: HarnessSessionContext;
  readonly containedTitle?: boolean;
}

export interface AcpHarnessOptions {
  readonly capabilities: HarnessCapabilities;
  readonly engineLabel: string;
  readonly launch: (
    options: AcpLaunchOptions,
  ) => Promise<HarnessProcessLaunch> | HarnessProcessLaunch;
  readonly policy: AcpSessionPolicy;
  readonly hooks: AcpNativeHooks;
  readonly maxEventBytes: number;
  readonly maxEventItems: number;
}

export interface AcpInspectionSnapshot {
  readonly agentCapabilities: Readonly<Record<string, unknown>>;
  readonly agentInfo?: { readonly name: string; readonly version: string };
  readonly authMethods: readonly { readonly id: string; readonly name: string }[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly protocolVersion: number;
}

export interface AcpSessionSnapshot {
  readonly configOptions: readonly AcpSessionConfigOption[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly modes?: {
    readonly currentModeId: string;
    readonly availableModes: readonly { readonly id: string; readonly name: string }[];
  };
  readonly sessionId: string;
}

export interface AcpSessionConfigOption {
  readonly category?: string;
  readonly currentValue: boolean | string;
  readonly id: string;
  readonly name: string;
  readonly options?: readonly {
    readonly description?: string;
    readonly label: string;
    readonly value: string;
  }[];
  readonly type: "boolean" | "select";
}

export interface AcpRequestBinding {
  readonly pending: PendingRequest;
  readonly settle: (response: unknown) => void;
}
