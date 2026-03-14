import { createBrowserCoreError } from "@opensteer/browser-core";

export interface CdpVersionResponse {
  readonly Browser?: string;
  readonly "Protocol-Version"?: string;
  readonly webSocketDebuggerUrl?: string;
}

export async function fetchBrowserWebSocketUrl(remoteDebuggingUrl: string): Promise<string> {
  const response = await fetch(`${remoteDebuggingUrl}/json/version`);
  if (!response.ok) {
    throw createBrowserCoreError(
      "operation-failed",
      `failed to query CDP version endpoint at ${remoteDebuggingUrl}`,
    );
  }

  const body = (await response.json()) as CdpVersionResponse;
  if (!body.webSocketDebuggerUrl) {
    throw createBrowserCoreError(
      "operation-failed",
      `CDP endpoint ${remoteDebuggingUrl} did not return a browser websocket URL`,
    );
  }

  return body.webSocketDebuggerUrl;
}

export function derivePageWebSocketUrl(browserWebSocketUrl: string, targetId: string): string {
  const url = new URL(browserWebSocketUrl);
  url.pathname = `/devtools/page/${targetId}`;
  url.search = "";
  return url.toString();
}
