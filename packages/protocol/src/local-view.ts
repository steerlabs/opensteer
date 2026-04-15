import type { OpensteerSessionOwnership } from "./session-info.js";

export interface OpensteerViewport {
  readonly width: number;
  readonly height: number;
}

export interface OpensteerViewStreamTab {
  readonly index: number;
  readonly targetId?: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export type OpensteerViewStreamControlMessage =
  | {
      readonly type: "hello";
      readonly sessionId: string;
      readonly ts: number;
      readonly mimeType: "image/jpeg";
      readonly fps: number;
      readonly quality: number;
      readonly viewport: OpensteerViewport;
    }
  | {
      readonly type: "tabs";
      readonly sessionId: string;
      readonly ts: number;
      readonly activeTabIndex: number;
      readonly tabs: readonly OpensteerViewStreamTab[];
    }
  | {
      readonly type: "status";
      readonly sessionId: string;
      readonly ts: number;
      readonly status: string;
    }
  | {
      readonly type: "error";
      readonly sessionId: string;
      readonly ts: number;
      readonly error: string;
    };

export interface OpensteerViewStreamClientMessage {
  readonly type: "stream-config";
  readonly renderWidth: number;
  readonly renderHeight: number;
}

export interface OpensteerLocalViewSessionSummary {
  readonly sessionId: string;
  readonly label: string;
  readonly status: "live" | "stale";
  readonly workspace?: string;
  readonly rootPath: string;
  readonly engine: "playwright" | "abp";
  readonly ownership: OpensteerSessionOwnership;
  readonly pid?: number;
  readonly startedAt: number;
  readonly browserName?: string;
}

export interface OpensteerLocalViewSessionsResponse {
  readonly sessions: readonly OpensteerLocalViewSessionSummary[];
}

export interface OpensteerLocalViewSessionCloseResponse {
  readonly sessionId: string;
  readonly closed: true;
}
