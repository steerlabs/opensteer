import { createBrowserCoreError, type HeaderEntry } from "@opensteer/browser-core";

import { AbpApiError } from "./errors.js";
import type {
  AbpActionRequest,
  AbpActionResponse,
  AbpBrowserStatus,
  AbpCurlResponse,
  AbpExecutionState,
  AbpNetworkQueryResponse,
  AbpRestClientLike,
  AbpTab,
} from "./types.js";

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
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/click`, {
      method: "POST",
      body,
    });
  }

  moveTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
    } & AbpActionRequest,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/move`, {
      method: "POST",
      body,
    });
  }

  scrollTab(
    tabId: string,
    body: {
      readonly x: number;
      readonly y: number;
      readonly delta_x?: number;
      readonly delta_y?: number;
    } & AbpActionRequest,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/scroll`, {
      method: "POST",
      body,
    });
  }

  keyPressTab(
    tabId: string,
    body: {
      readonly key: string;
      readonly modifiers?: readonly string[];
    } & AbpActionRequest,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/keyboard/press`, {
      method: "POST",
      body,
    });
  }

  typeTab(
    tabId: string,
    body: {
      readonly text: string;
    } & AbpActionRequest,
  ): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/type`, {
      method: "POST",
      body,
    });
  }

  screenshotTab(tabId: string, body: AbpActionRequest): Promise<AbpActionResponse> {
    return this.requestJson(`/tabs/${tabId}/screenshot`, {
      method: "POST",
      body,
    });
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

  queryNetwork(input: {
    readonly tabId?: string;
    readonly includeBodies: boolean;
  }): Promise<AbpNetworkQueryResponse> {
    const params = new URLSearchParams();
    if (input.tabId !== undefined) {
      params.set("tab_id", input.tabId);
    }
    if (input.includeBodies) {
      params.set("include_body", "true");
    }
    return this.requestJson(`/network?${params.toString()}`);
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
    return this.requestJson(`/tabs/${tabId}/curl`, {
      method: "POST",
      body,
    });
  }

  private async requestJson<T>(
    path: string,
    options: {
      readonly method?: string;
      readonly body?: unknown;
    } = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...Object.fromEntries(this.extraHeaders.map((header) => [header.name, header.value])),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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

    return parsed as T;
  }
}

export function buildImmediateActionRequest(
  options: {
    readonly captureNetwork?: boolean;
    readonly screenshot?: {
      readonly cursor?: boolean;
      readonly format?: string;
    };
  } = {},
): AbpActionRequest {
  return {
    wait_until: {
      type: "immediate",
    },
    ...(options.screenshot === undefined
      ? {}
      : {
          screenshot: {
            area: "viewport",
            ...(options.screenshot.cursor === undefined
              ? {}
              : { cursor: options.screenshot.cursor }),
            ...(options.screenshot.format === undefined
              ? {}
              : { format: options.screenshot.format }),
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

export function buildImmediateScreenshotRequest(
  screenshot: {
    readonly cursor?: boolean;
    readonly format?: string;
  } = {},
): AbpActionRequest {
  return buildImmediateActionRequest({
    captureNetwork: false,
    screenshot,
  });
}

export function encodeHeaders(entries: readonly HeaderEntry[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of entries ?? []) {
    headers[entry.name] = entry.value;
  }
  return headers;
}

export function assertUtf8RequestBody(input: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    throw createBrowserCoreError(
      "unsupported-capability",
      "binary request bodies are not supported by ABP session HTTP",
      {
        cause: error,
      },
    );
  }
}
