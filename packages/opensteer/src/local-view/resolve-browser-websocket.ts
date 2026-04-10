import { inspectCdpEndpoint } from "../local-browser/cdp-discovery.js";
import type { PersistedLocalBrowserSessionRecord } from "../live-session.js";

export async function resolveBrowserWebSocketUrl(
  record: PersistedLocalBrowserSessionRecord,
): Promise<string> {
  if (record.engine === "playwright") {
    if (!record.endpoint) {
      throw new Error("Local Playwright session is missing a browser WebSocket endpoint.");
    }
    return record.endpoint;
  }

  if (!record.remoteDebuggingUrl) {
    throw new Error("Local ABP session is missing a remote debugging URL.");
  }

  const inspected = await inspectCdpEndpoint({
    endpoint: record.remoteDebuggingUrl,
    timeoutMs: 5_000,
  });
  return inspected.endpoint;
}
