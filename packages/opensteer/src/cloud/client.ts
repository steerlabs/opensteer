import type { OpensteerCloudConfig } from "./config.js";
import type { OpensteerBrowserContextOptions, OpensteerBrowserLaunchOptions } from "@opensteer/protocol";
import type {
  BrowserProfileImportCreateRequest,
  BrowserProfileImportCreateResponse,
  BrowserProfileImportDescriptor,
  BrowserProfileImportFinalizeRequest,
  CloudBrowserProfilePreference,
} from "@opensteer/cloud-contracts";
import {
  uploadLocalBrowserProfile,
  type UploadLocalBrowserProfileInput,
} from "./profile-upload.js";

export interface OpensteerCloudSessionCreateInput {
  readonly name?: string;
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly browserProfile?: CloudBrowserProfilePreference;
}

export interface OpensteerCloudSessionDescriptor {
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly status?: string;
}

export type { UploadLocalBrowserProfileInput };

export class OpensteerCloudClient {
  constructor(private readonly config: OpensteerCloudConfig) {}

  getConfig(): OpensteerCloudConfig {
    return this.config;
  }

  async createSession(
    input: OpensteerCloudSessionCreateInput = {},
  ): Promise<OpensteerCloudSessionDescriptor> {
    const response = await this.request("/v1/sessions", {
      method: "POST",
      body: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.browserProfile === undefined ? {} : { browserProfile: input.browserProfile }),
      },
    });

    return (await response.json()) as OpensteerCloudSessionDescriptor;
  }

  async listSessions(): Promise<unknown> {
    const response = await this.request("/v1/sessions", {
      method: "GET",
    });
    return response.json();
  }

  async getSession(sessionId: string): Promise<unknown> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });
    return response.json();
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  async createBrowserProfileImport(
    input: BrowserProfileImportCreateRequest,
  ): Promise<BrowserProfileImportCreateResponse> {
    const response = await this.request("/v1/browser-profiles/imports", {
      method: "POST",
      body: input,
    });
    return (await response.json()) as BrowserProfileImportCreateResponse;
  }

  async uploadBrowserProfileImportPayload(input: {
    readonly uploadUrl: string;
    readonly payload: Buffer | Uint8Array;
  }): Promise<{ readonly storageId: string }> {
    const response = await fetch(input.uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: input.payload,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`POST ${input.uploadUrl} failed with ${String(response.status)}.`);
    }

    const payload = (await response.json()) as {
      readonly storageId?: unknown;
    };
    if (typeof payload.storageId !== "string" || payload.storageId.trim().length === 0) {
      throw new Error("Profile upload response did not include storageId.");
    }

    return {
      storageId: payload.storageId,
    };
  }

  async finalizeBrowserProfileImport(
    importId: string,
    input: BrowserProfileImportFinalizeRequest,
  ): Promise<BrowserProfileImportDescriptor> {
    const response = await this.request(
      `/v1/browser-profiles/imports/${encodeURIComponent(importId)}/finalize`,
      {
        method: "POST",
        body: input,
      },
    );
    return (await response.json()) as BrowserProfileImportDescriptor;
  }

  async getBrowserProfileImport(importId: string): Promise<BrowserProfileImportDescriptor> {
    const response = await this.request(
      `/v1/browser-profiles/imports/${encodeURIComponent(importId)}`,
      {
        method: "GET",
      },
    );
    return (await response.json()) as BrowserProfileImportDescriptor;
  }

  async uploadLocalBrowserProfile(
    input: UploadLocalBrowserProfileInput,
  ): Promise<BrowserProfileImportDescriptor> {
    return uploadLocalBrowserProfile(this, input);
  }

  buildAuthorizationHeader(): string {
    return `Bearer ${this.config.apiKey}`;
  }

  private buildHeaders(): Record<string, string> {
    return {
      authorization: this.buildAuthorizationHeader(),
      "content-type": "application/json; charset=utf-8",
    };
  }

  private async request(
    pathname: string,
    init: {
      readonly method: "GET" | "POST" | "DELETE";
      readonly body?: unknown;
    },
  ): Promise<Response> {
    const response = await fetch(`${this.config.baseUrl}${pathname}`, {
      method: init.method,
      headers: this.buildHeaders(),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`${init.method} ${pathname} failed with ${String(response.status)}.`);
    }
    return response;
  }
}
