import { createBrowserCoreError, type HeaderEntry } from "@opensteer/browser-core";

import { AbpApiError } from "./errors.js";
import type {
  AbpActionRequest,
  AbpActionResponse,
  AbpBrowserStatus,
  AbpCurlResponse,
  AbpCurlWireResponse,
  AbpDialogInfo,
  AbpExecuteResult,
  AbpExecutionState,
  AbpNetworkCall,
  AbpNetworkQueryWireResponse,
  AbpRequestOptions,
  AbpRestClientLike,
  AbpWaitUntil,
  AbpTab,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidAbpResponse(path: string): never {
  throw createBrowserCoreError(
    "operation-failed",
    `ABP ${path} returned an invalid response shape`,
  );
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function normalizeNetworkQueryResponse(value: unknown): readonly AbpNetworkCall[] {
  if (!isRecord(value)) {
    invalidAbpResponse("/network");
  }

  const response = value as Partial<AbpNetworkQueryWireResponse>;
  if (!Array.isArray(response.requests)) {
    invalidAbpResponse("/network");
  }

  return response.requests as readonly AbpNetworkCall[];
}

function normalizeCurlResponse(value: unknown): AbpCurlResponse {
  if (!isRecord(value)) {
    invalidAbpResponse("/tabs/{tabId}/curl");
  }

  const response = value as Partial<AbpCurlWireResponse>;
  const status = response.status_code;
  const headers = readStringRecord(response.headers);
  const body = response.body;
  const bodyIsBase64 = response.body_is_base64;
  const url = response.final_url;
  const redirected = response.redirected;
  if (
    !Number.isInteger(status) ||
    headers === undefined ||
    typeof bodyIsBase64 !== "boolean" ||
    typeof url !== "string" ||
    typeof redirected !== "boolean" ||
    (body !== undefined && typeof body !== "string")
  ) {
    invalidAbpResponse("/tabs/{tabId}/curl");
  }

  return {
    status: status!,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(body === undefined ? {} : { bodyEncoding: bodyIsBase64 ? "base64" : "text" }),
    url: url!,
    redirected: redirected!,
  };
}

function normalizeExecuteResponse(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.result) || !("value" in value.result)) {
    invalidAbpResponse("/tabs/{tabId}/execute");
  }

  const result = value.result as unknown as AbpExecuteResult;
  return result.value;
}

const DEFAULT_ACTION_COMPLETE_TIMEOUT_MS = 10_000;

export class AbpRestClient implements AbpRestClientLike {
  private readonly baseUrl: string;
  private readonly extraHeaders: readonly HeaderEntry[];

  constructor(baseUrl: string, extraHeaders: readonly HeaderEntry[] = []) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.extraHeaders = extraHeaders;
  }

  getBrowserStatus(): Promise<AbpBrowserStatus> {
    return this.requestJson("/browser/status");
  }

  async shutdownBrowser(): Promise<void> {
    await this.requestJson("/browser/shutdown", {
      method: "POST",
      body: {},
    });
  }

  listTabs(): Promise<readonly AbpTab[]> {
    return this.requestJson("/tabs");
  }

  getTab(tabId: string): Promise<AbpTab> {
    return this.requestJson(`/tabs/${tabId}`);
  }

  createTab(): Promise<AbpTab> {
    return this.requestJson("/tabs", {
      method: "POST",
      body: {},
    });
  }

  async closeTab(tabId: string): Promise<void> {
    await this.requestJson(`/tabs/${tabId}`, {
      method: "DELETE",
    });
  }

  async activateTab(tabId: string): Promise<void> {
    await this.requestJson(`/tabs/${tabId}/activate`, {
      method: "POST",
      body: {},
    });
  }

  async stopTab(tabId: string): Promise<void> {
    await this.requestJson(`/tabs/${tabId}/stop`, {
      method: "POST",
      body: {},
    });
  }

  navigateTab(
    tabId: string,
    body: {
      readonly url: string;
      readonly referrer?: string;
    } & AbpActionRequest,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/navigate`, {
      method: "POST",
      body,
    });
  }

  reloadTab(tabId: string, body: AbpActionRequest): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/reload`, {
      method: "POST",
      body,
    });
  }

  goBack(tabId: string, body: AbpActionRequest): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/back`, {
      method: "POST",
      body,
    });
  }

  goForward(tabId: string, body: AbpActionRequest): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/forward`, {
      method: "POST",
      body,
    });
  }

  clickTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
      readonly button?: string;
      readonly click_count?: number;
      readonly modifiers?: readonly string[];
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/click`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  moveTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/move`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  scrollTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
      readonly scrolls: readonly {
        readonly delta_px: number;
        readonly direction: "x" | "y";
      }[];
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/scroll`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  dragTab(
    tabId: string,
    body: {
      readonly start_x: number;
      readonly start_y: number;
      readonly end_x: number;
      readonly end_y: number;
      readonly steps?: number;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/drag`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  keyPressTab(
    tabId: string,
    body: {
      readonly key: string;
      readonly modifiers?: readonly string[];
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/keyboard/press`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  typeTab(
    tabId: string,
    body: {
      readonly text: string;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/type`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  waitTab(
    tabId: string,
    body: {
      readonly duration_ms: number;
    } & AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/wait`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  screenshotTab(
    tabId: string,
    body: AbpActionRequest,
    options?: AbpRequestOptions,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/screenshot`, {
      method: "POST",
      body,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  executeScript<TResult = unknown>(
    tabId: string,
    script: string,
    options: AbpActionRequest = {},
  ): Promise<TResult> {
    return this.requestJson(
      `/tabs/${tabId}/execute`,
      {
        method: "POST",
        body: { script, ...options },
      },
      normalizeExecuteResponse as (value: unknown) => TResult,
    );
  }

  getExecutionState(tabId: string): Promise<AbpExecutionState> {
    return this.requestJson(`/tabs/${tabId}/execution`);
  }

  setExecutionState(
    tabId: string,
    body: {
      readonly paused: boolean;
    },
  ): Promise<AbpExecutionState> {
    return this.requestJson(`/tabs/${tabId}/execution`, {
      method: "POST",
      body,
    });
  }

  async getDialog(tabId: string): Promise<AbpDialogInfo | undefined> {
    const result = await this.requestJson<Record<string, unknown>>(`/tabs/${tabId}/dialog`);
    if (!result || result.present !== true) {
      return undefined;
    }
    return {
      dialogType: String(result.dialog_type ?? result.dialogType ?? "alert"),
      message: String(result.message ?? ""),
      defaultPrompt: typeof result.default_prompt === "string" ? result.default_prompt : undefined,
    };
  }

  acceptDialog(tabId: string): Promise<void> {
    return this.requestJson(`/tabs/${tabId}/dialog/accept`, {
      method: "POST",
      body: {},
    });
  }

  dismissDialog(tabId: string): Promise<void> {
    return this.requestJson(`/tabs/${tabId}/dialog/dismiss`, {
      method: "POST",
      body: {},
    });
  }

  queryNetwork(input: {
    readonly tabId?: string;
    readonly includeBodies: boolean;
  }): Promise<readonly AbpNetworkCall[]> {
    const params = new URLSearchParams();
    if (input.tabId !== undefined) {
      params.set("tab_id", input.tabId);
    }
    if (input.includeBodies) {
      params.set("include_body", "true");
    }
    return this.requestJson(`/network?${params.toString()}`, {}, normalizeNetworkQueryResponse);
  }

  curlTab(
    tabId: string,
    body: {
      readonly url: string;
      readonly method: string;
      readonly headers?: Record<string, string>;
      readonly body?: string;
    },
  ): Promise<AbpCurlResponse> {
    return this.requestJson(
      `/tabs/${tabId}/curl`,
      {
        method: "POST",
        body,
      },
      normalizeCurlResponse,
    );
  }

  private async requestJson<T>(
    path: string,
    options: {
      readonly method?: string;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
    } = {},
    normalize?: (value: unknown) => T,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...Object.fromEntries(this.extraHeaders.map((header) => [header.name, header.value])),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const parsed = contentType.includes("application/json")
      ? ((await response.json()) as unknown)
      : await response.text();

    if (!response.ok) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "string"
          ? parsed.error
          : response.statusText || `ABP request failed with HTTP ${String(response.status)}`;
      throw new AbpApiError(response.status, message, parsed);
    }

    return normalize ? normalize(parsed) : (parsed as T);
  }
}

export function buildImmediateActionRequest(
  options: {
    readonly captureNetwork?: boolean;
    readonly waitUntil?: AbpWaitUntil;
    readonly screenshot?: {
      readonly area?: "none" | "viewport";
      readonly cursor?: boolean;
      readonly format?: string;
      readonly markup?: readonly string[];
    };
  } = {},
): AbpActionRequest {
  return {
    wait_until: options.waitUntil ?? {
      type: "immediate",
    },
    ...(options.screenshot === undefined
      ? {}
      : {
          screenshot: {
            area: options.screenshot.area ?? "viewport",
            ...(options.screenshot.cursor === undefined
              ? {}
              : { cursor: options.screenshot.cursor }),
            ...(options.screenshot.format === undefined
              ? {}
              : { format: options.screenshot.format }),
            ...(options.screenshot.markup === undefined
              ? {}
              : { markup: [...options.screenshot.markup] }),
          },
        }),
    ...(options.captureNetwork === false
      ? {}
      : {
          network: {
            types: ["Document", "XHR", "Fetch"],
          },
        }),
  };
}

export function buildInputActionRequest(
  options: {
    readonly captureNetwork?: boolean;
    readonly timeoutMs?: number;
    readonly omitDefaultTimeout?: boolean;
    readonly screenshot?: {
      readonly cursor?: boolean;
      readonly format?: string;
      readonly markup?: readonly string[];
    };
  } = {},
): AbpActionRequest {
  return buildImmediateActionRequest({
    ...(options.captureNetwork === undefined ? {} : { captureNetwork: options.captureNetwork }),
    waitUntil: buildActionCompleteWaitUntil({
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.omitDefaultTimeout === undefined
        ? {}
        : { omitDefaultTimeout: options.omitDefaultTimeout }),
    }),
    ...(options.screenshot === undefined ? {} : { screenshot: options.screenshot }),
  });
}

export function buildImmediateScreenshotRequest(
  screenshot: {
    readonly cursor?: boolean;
    readonly format?: string;
    readonly markup?: readonly string[];
  } = {},
): AbpActionRequest {
  return buildImmediateActionRequest({
    captureNetwork: false,
    screenshot,
  });
}

function buildActionCompleteWaitUntil(options: {
  readonly timeoutMs?: number;
  readonly omitDefaultTimeout?: boolean;
}): AbpWaitUntil {
  const timeoutMs =
    options.timeoutMs === undefined
      ? options.omitDefaultTimeout
        ? undefined
        : DEFAULT_ACTION_COMPLETE_TIMEOUT_MS
      : normalizeActionTimeoutMs(options.timeoutMs);

  return {
    type: "action_complete",
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
  };
}

function normalizeActionTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw createBrowserCoreError(
      "invalid-argument",
      `ABP action timeout must be a non-negative finite number, received ${String(timeoutMs)}`,
    );
  }

  return Math.max(1, Math.ceil(timeoutMs));
}
