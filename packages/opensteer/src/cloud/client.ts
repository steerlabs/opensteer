import type { OpensteerCloudConfig } from "./config.js";
import type { OpensteerBrowserContextOptions, OpensteerBrowserLaunchOptions } from "@opensteer/protocol";

export interface OpensteerCloudSessionCreateInput {
  readonly name?: string;
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
}

export interface OpensteerCloudSessionDescriptor {
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly status?: string;
}

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
