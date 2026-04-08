import { detectLocalBrowserInstallations, readDevToolsActivePort } from "./chrome-discovery.js";
import type { InspectedCdpEndpoint, LocalCdpBrowserCandidate } from "./types.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 2_000;
const DISCOVERY_FALLBACK_PORT = 9222;

interface InspectCdpEndpointInput {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

interface ProbeCdpEndpointInput extends InspectCdpEndpointInput {
  readonly fallbackBrowserWebSocketPath?: string;
}

interface NormalizedProbeTarget {
  readonly fallbackBrowserWebSocketUrl?: string;
  readonly httpUrl: URL;
}

interface CdpVersionResponse {
  readonly Browser?: string;
  readonly "Protocol-Version"?: string;
  readonly webSocketDebuggerUrl?: string;
}

export class OpensteerAttachAmbiguousError extends Error {
  readonly code = "attach-ambiguous";

  constructor(readonly candidates: readonly LocalCdpBrowserCandidate[]) {
    super(
      "Multiple running Chromium DevTools endpoints were discovered. Specify the desired endpoint explicitly.",
    );
    this.name = "OpensteerAttachAmbiguousError";
  }
}

export async function inspectCdpEndpoint(
  input: InspectCdpEndpointInput,
): Promise<InspectedCdpEndpoint> {
  const inspected = await probeCdpEndpoint(input);
  if (inspected === null) {
    throw new Error(`Could not inspect CDP endpoint "${input.endpoint}".`);
  }
  return inspected;
}

export async function discoverLocalCdpBrowsers(
  input: {
    readonly timeoutMs?: number;
  } = {},
): Promise<readonly LocalCdpBrowserCandidate[]> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const candidates: LocalCdpBrowserCandidate[] = [];

  for (const installation of detectLocalBrowserInstallations()) {
    const activePort = readDevToolsActivePort(installation.userDataDir);
    if (!activePort) {
      continue;
    }

    const inspected = await probeCdpEndpoint({
      endpoint: `http://127.0.0.1:${String(activePort.port)}`,
      timeoutMs,
      fallbackBrowserWebSocketPath: activePort.webSocketPath,
    });
    if (inspected === null) {
      continue;
    }

    candidates.push({
      ...inspected,
      source: "devtools-active-port",
      installationBrand: installation.brand,
      userDataDir: installation.userDataDir,
    });
  }

  const fallbackCandidate = await probeCdpEndpoint({
    endpoint: String(DISCOVERY_FALLBACK_PORT),
    timeoutMs,
  });
  if (fallbackCandidate !== null) {
    candidates.push({
      ...fallbackCandidate,
      source: "fallback-port",
    });
  }

  return dedupeAndSortCandidates(candidates);
}

export async function selectAttachBrowserCandidate(
  input: {
    readonly timeoutMs?: number;
  } = {},
): Promise<LocalCdpBrowserCandidate> {
  const candidates = await discoverLocalCdpBrowsers(input);
  if (candidates.length === 0) {
    throw new Error(
      "No running Chromium browser instance found. Enable remote debugging or specify an attach endpoint explicitly.",
    );
  }

  const highestPriority = Math.max(...candidates.map(getAttachCandidatePriority));
  const winners = candidates.filter(
    (candidate) => getAttachCandidatePriority(candidate) === highestPriority,
  );
  if (winners.length === 1) {
    return winners[0]!;
  }

  throw new OpensteerAttachAmbiguousError(candidates);
}

async function probeCdpEndpoint(
  input: ProbeCdpEndpointInput,
): Promise<InspectedCdpEndpoint | null> {
  const trimmedEndpoint = input.endpoint.trim();
  if (!trimmedEndpoint) {
    return null;
  }

  const target = normalizeProbeTarget(trimmedEndpoint);
  const timeoutMs = input.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

  const versionPayload = await fetchJson<CdpVersionResponse>(
    new URL("/json/version", target.httpUrl),
    input.headers,
    timeoutMs,
  );
  if (versionPayload !== null) {
    const payload = versionPayload;
    if (
      typeof payload.webSocketDebuggerUrl === "string" &&
      payload.webSocketDebuggerUrl.length > 0
    ) {
      return createInspectedCdpEndpoint({
        browserWebSocketUrl: rewriteBrowserWebSocketHost(
          payload.webSocketDebuggerUrl,
          target.httpUrl,
        ),
        httpUrl: target.httpUrl,
        ...(payload.Browser === undefined ? {} : { browser: payload.Browser }),
        ...(payload["Protocol-Version"] === undefined
          ? {}
          : { protocolVersion: payload["Protocol-Version"] }),
      });
    }
  }

  const listPayload = await fetchJson<
    readonly {
      readonly type?: unknown;
      readonly webSocketDebuggerUrl?: unknown;
    }[]
  >(new URL("/json/list", target.httpUrl), input.headers, timeoutMs);
  if (listPayload !== null) {
    const browserTarget =
      listPayload.find((candidate) => candidate.type === "browser") ??
      listPayload.find((candidate) => typeof candidate.webSocketDebuggerUrl === "string");
    if (typeof browserTarget?.webSocketDebuggerUrl === "string") {
      return createInspectedCdpEndpoint({
        browserWebSocketUrl: rewriteBrowserWebSocketHost(
          browserTarget.webSocketDebuggerUrl,
          target.httpUrl,
        ),
        httpUrl: target.httpUrl,
      });
    }
  }

  if (
    input.fallbackBrowserWebSocketPath !== undefined &&
    (await isHttpEndpointReachable(target.httpUrl, timeoutMs))
  ) {
    return createInspectedCdpEndpoint({
      browserWebSocketUrl: buildBrowserWebSocketUrl(
        target.httpUrl,
        input.fallbackBrowserWebSocketPath,
      ),
      httpUrl: target.httpUrl,
    });
  }

  if (
    target.fallbackBrowserWebSocketUrl !== undefined &&
    (await isHttpEndpointReachable(target.httpUrl, timeoutMs))
  ) {
    return createInspectedCdpEndpoint({
      browserWebSocketUrl: target.fallbackBrowserWebSocketUrl,
      httpUrl: target.httpUrl,
    });
  }

  return null;
}

function dedupeAndSortCandidates(
  candidates: readonly LocalCdpBrowserCandidate[],
): readonly LocalCdpBrowserCandidate[] {
  const deduped = new Map<string, LocalCdpBrowserCandidate>();

  for (const candidate of [...candidates].sort(compareCandidates)) {
    const existing = deduped.get(candidate.endpoint);
    if (!existing || compareCandidates(candidate, existing) < 0) {
      deduped.set(candidate.endpoint, candidate);
    }
  }

  return [...deduped.values()].sort(compareCandidates);
}

function compareCandidates(
  left: LocalCdpBrowserCandidate,
  right: LocalCdpBrowserCandidate,
): number {
  return (
    getAttachCandidatePriority(right) - getAttachCandidatePriority(left) ||
    left.endpoint.localeCompare(right.endpoint) ||
    (left.userDataDir ?? "").localeCompare(right.userDataDir ?? "")
  );
}

function getAttachCandidatePriority(candidate: LocalCdpBrowserCandidate): number {
  return candidate.source === "devtools-active-port" ? 2 : 1;
}

function createInspectedCdpEndpoint(input: {
  readonly browser?: string;
  readonly browserWebSocketUrl: string;
  readonly httpUrl: URL;
  readonly protocolVersion?: string;
}): InspectedCdpEndpoint {
  const port = readPort(input.httpUrl);
  return {
    endpoint: input.browserWebSocketUrl,
    ...(input.browser === undefined ? {} : { browser: input.browser }),
    ...(input.protocolVersion === undefined ? {} : { protocolVersion: input.protocolVersion }),
    httpUrl: input.httpUrl.toString(),
    ...(port === undefined ? {} : { port }),
  };
}

function normalizeProbeTarget(endpoint: string): NormalizedProbeTarget {
  if (/^\d+$/.test(endpoint)) {
    return {
      httpUrl: new URL(`http://127.0.0.1:${endpoint}`),
    };
  }

  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
    const url = new URL(endpoint);
    return {
      fallbackBrowserWebSocketUrl: url.toString(),
      httpUrl: new URL(`${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`),
    };
  }

  try {
    const url =
      endpoint.startsWith("http://") || endpoint.startsWith("https://")
        ? new URL(endpoint)
        : new URL(`http://${endpoint}`);
    return {
      httpUrl: new URL(`${url.protocol}//${url.host}`),
    };
  } catch {
    throw new Error(`Invalid CDP endpoint "${endpoint}".`);
  }
}

async function fetchJson<T>(
  url: URL,
  headers: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
): Promise<T | null> {
  const response = await fetch(url, {
    ...(headers === undefined ? {} : { headers }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }

  return (await response.json()) as T;
}

async function isHttpEndpointReachable(url: URL, timeoutMs: number): Promise<boolean> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  return response !== null;
}

function buildBrowserWebSocketUrl(httpUrl: URL, webSocketPath: string): string {
  const protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${httpUrl.host}${normalizeWebSocketPath(webSocketPath)}`;
}

function normalizeWebSocketPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function rewriteBrowserWebSocketHost(browserWsUrl: string, requestedUrl: URL): string {
  try {
    const parsed = new URL(browserWsUrl);
    parsed.protocol = requestedUrl.protocol === "https:" ? "wss:" : "ws:";
    parsed.hostname = requestedUrl.hostname;
    parsed.port = requestedUrl.port;
    return parsed.toString();
  } catch {
    return browserWsUrl;
  }
}

function readPort(url: URL): number | undefined {
  const port = Number.parseInt(url.port, 10);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}
