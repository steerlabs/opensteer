import type { OpensteerCloudConfig } from "./config.js";
import type {
  BrowserProfileImportCreateRequest,
  BrowserProfileImportCreateResponse,
  BrowserProfileImportDescriptor,
  CloudSessionRecordingState,
  CloudBrowserProfilePreference,
  CloudRequestPlanImportRequest,
  CloudRegistryImportEntry,
  CloudRegistryImportResponse,
  OpensteerSessionAccessGrantResponse,
  OpensteerSessionGrant,
  OpensteerSessionGrantKind,
  OpensteerBrowserContextOptions,
  OpensteerBrowserLaunchOptions,
  ObservabilityConfig,
} from "@opensteer/protocol";
import { syncBrowserProfileCookies, type SyncBrowserProfileCookiesInput } from "./profile-sync.js";

export interface OpensteerCloudSessionCreateInput {
  readonly name?: string;
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly browserProfile?: CloudBrowserProfilePreference;
  readonly observability?: Partial<ObservabilityConfig>;
  readonly sourceType?: "manual" | "local-cloud";
  readonly sourceRef?: string;
  readonly localWorkspaceRootPath?: string;
}

export interface OpensteerCloudSessionDescriptor {
  readonly sessionId: string;
  readonly status?: string;
  readonly baseUrl?: string;
  readonly initialGrants?: Partial<Record<OpensteerSessionGrantKind, OpensteerSessionGrant>>;
  readonly initialGrantExpiresAt?: number;
}

interface OpensteerCloudSessionState {
  readonly status?: string;
}

interface OpensteerCloudSessionCloseDescriptor {
  readonly status?: string;
}

interface CloudRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

const CLOUD_CLOSE_TIMEOUT_MS = 60_000;
const CLOUD_CLOSE_POLL_INTERVAL_MS = 250;

export type { SyncBrowserProfileCookiesInput };

export class OpensteerCloudClient {
  constructor(private readonly config: OpensteerCloudConfig) {}

  getConfig(): OpensteerCloudConfig {
    return this.config;
  }

  async createSession(
    input: OpensteerCloudSessionCreateInput = {},
    options: CloudRequestOptions = {},
  ): Promise<OpensteerCloudSessionDescriptor> {
    const response = await this.request("/v1/sessions", {
      method: "POST",
      body: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.browserProfile === undefined ? {} : { browserProfile: input.browserProfile }),
        ...(input.observability === undefined ? {} : { observability: input.observability }),
        ...(input.sourceType === undefined ? {} : { sourceType: input.sourceType }),
        ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
        ...(input.localWorkspaceRootPath === undefined
          ? {}
          : { localWorkspaceRootPath: input.localWorkspaceRootPath }),
      },
    }, options);

    return (await response.json()) as OpensteerCloudSessionDescriptor;
  }

  async listSessions(): Promise<unknown> {
    const response = await this.request("/v1/sessions", {
      method: "GET",
    });
    return response.json();
  }

  async getSession(
    sessionId: string,
    options: CloudRequestOptions = {},
  ): Promise<OpensteerCloudSessionState> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    }, options);
    return (await response.json()) as OpensteerCloudSessionState;
  }

  async issueAccess(
    sessionId: string,
    capabilities: readonly OpensteerSessionGrantKind[],
    options: CloudRequestOptions = {},
  ): Promise<OpensteerSessionAccessGrantResponse> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/access`, {
      method: "POST",
      body: {
        capabilities,
      },
    }, options);
    return (await response.json()) as OpensteerSessionAccessGrantResponse;
  }

  async getSessionRecording(sessionId: string): Promise<CloudSessionRecordingState> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/recording`, {
      method: "GET",
    });
    return (await response.json()) as CloudSessionRecordingState;
  }

  async startSessionRecording(sessionId: string): Promise<CloudSessionRecordingState> {
    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/recording/start`,
      {
        method: "POST",
      },
    );
    return (await response.json()) as CloudSessionRecordingState;
  }

  async stopSessionRecording(sessionId: string): Promise<CloudSessionRecordingState> {
    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/recording/stop`,
      {
        method: "POST",
      },
    );
    return (await response.json()) as CloudSessionRecordingState;
  }

  async closeSession(sessionId: string): Promise<void> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    const payload = (await response.json()) as OpensteerCloudSessionCloseDescriptor;
    if (payload.status === "closed") {
      return;
    }

    if (payload.status !== "closing") {
      throw new Error(`Unexpected cloud close status "${String(payload.status)}".`);
    }

    await this.waitForSessionClosed(sessionId);
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
  }): Promise<BrowserProfileImportDescriptor> {
    let response: Response;
    try {
      response = await fetch(input.uploadUrl, {
        method: "PUT",
        headers: {
          authorization: this.buildAuthorizationHeader(),
          "content-type": "application/octet-stream",
        },
        body: input.payload,
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (error) {
      throw wrapCloudFetchError(error, {
        method: "PUT",
        url: input.uploadUrl,
      });
    }
    if (!response.ok) {
      throw new Error(`PUT ${input.uploadUrl} failed with ${String(response.status)}.`);
    }

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

  async syncBrowserProfileCookies(
    input: SyncBrowserProfileCookiesInput,
  ): Promise<BrowserProfileImportDescriptor> {
    return syncBrowserProfileCookies(this, input);
  }

  async importDescriptors(
    entries: readonly CloudRegistryImportEntry[],
  ): Promise<CloudRegistryImportResponse> {
    const response = await this.request("/registry/descriptors/import", {
      method: "POST",
      body: { entries },
    });
    return (await response.json()) as CloudRegistryImportResponse;
  }

  async importRequestPlans(
    input: CloudRequestPlanImportRequest,
  ): Promise<CloudRegistryImportResponse> {
    const response = await this.request("/registry/request-plans/import", {
      method: "POST",
      body: input,
    });
    return (await response.json()) as CloudRegistryImportResponse;
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
    options: CloudRequestOptions = {},
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: this.buildHeaders(),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: createRequestSignal(options),
      });
    } catch (error) {
      throw wrapCloudFetchError(error, {
        method: init.method,
        url,
      });
    }
    if (!response.ok) {
      throw new Error(`${init.method} ${pathname} failed with ${String(response.status)}.`);
    }
    return response;
  }

  private async waitForSessionClosed(sessionId: string): Promise<void> {
    const deadline = Date.now() + CLOUD_CLOSE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const session = await this.getSession(sessionId);
      if (session.status === "closed") {
        return;
      }
      if (session.status !== "closing") {
        throw new Error(
          `Unexpected cloud session status "${String(session.status)}" while waiting for close.`,
        );
      }
      await delay(CLOUD_CLOSE_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for cloud session ${sessionId} to close.`);
  }
}

function createRequestSignal(options: CloudRequestOptions): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  if (options.signal === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([options.signal, timeoutSignal]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function wrapCloudFetchError(
  error: unknown,
  input: {
    readonly method: string;
    readonly url: string;
  },
): Error {
  if (!(error instanceof Error)) {
    return new Error(
      `Failed to reach Opensteer cloud endpoint ${input.method} ${input.url}. Check OPENSTEER_BASE_URL and network reachability from this environment.`,
    );
  }

  const wrapped = new Error(
    `Failed to reach Opensteer cloud endpoint ${input.method} ${input.url}. Check OPENSTEER_BASE_URL and network reachability from this environment.`,
    {
      cause: error,
    },
  );
  wrapped.name = error.name;
  return wrapped;
}
