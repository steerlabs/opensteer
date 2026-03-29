import type {
  BodyPayload,
  HeaderEntry,
  NetworkRecord,
  PageRef,
  SessionRef,
} from "@opensteer/browser-core";

export interface OpensteerRouteRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: readonly HeaderEntry[];
  readonly resourceType: NetworkRecord["resourceType"];
  readonly pageRef?: PageRef;
  readonly postData?: BodyPayload;
}

export interface OpensteerFetchedRouteResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: BodyPayload;
  readonly redirected: boolean;
}

export type OpensteerRouteHandlerResult =
  | {
      readonly kind: "continue";
    }
  | {
      readonly kind: "fulfill";
      readonly status?: number;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: string | Uint8Array;
      readonly contentType?: string;
    }
  | {
      readonly kind: "abort";
      readonly errorCode?: string;
    };

export interface OpensteerRouteOptions {
  readonly pageRef?: PageRef;
  readonly urlPattern: string;
  readonly resourceTypes?: readonly NetworkRecord["resourceType"][];
  readonly times?: number;
  readonly handler: (input: {
    readonly request: OpensteerRouteRequest;
    fetchOriginal(): Promise<OpensteerFetchedRouteResponse>;
  }) => OpensteerRouteHandlerResult | Promise<OpensteerRouteHandlerResult>;
}

export interface OpensteerRouteRegistration {
  readonly routeId: string;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly urlPattern: string;
}

export interface OpensteerInterceptScriptOptions {
  readonly pageRef?: PageRef;
  readonly urlPattern: string;
  readonly times?: number;
  readonly handler: (input: {
    readonly url: string;
    readonly content: string;
    readonly headers: readonly HeaderEntry[];
    readonly status: number;
  }) => string | Promise<string>;
}

export interface OpensteerInstrumentableRuntime {
  route(input: OpensteerRouteOptions): Promise<OpensteerRouteRegistration>;
  interceptScript(input: OpensteerInterceptScriptOptions): Promise<OpensteerRouteRegistration>;
}
