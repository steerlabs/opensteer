import type { WebSocketClient } from "@opensteer/client/host";

/**
 * React Native's `WebSocket` takes request headers; the DOM's does not.
 *
 * The runtime global in a React Native bundle is
 * `react-native/Libraries/WebSocket/WebSocket`, whose constructor accepts
 * `(url, protocols, options)`. TypeScript sees the DOM lib's two-argument
 * declaration because this package compiles against DOM types, so the real
 * shape is declared here, for this file only. It is a declaration of what the
 * runtime is, not a cast: everything below it is checked against it.
 */
declare const WebSocket: {
  new (
    url: string,
    protocols: string | readonly string[] | undefined,
    options: { readonly headers: Readonly<Record<string, string>> },
  ): WebSocketClient;
};

/** Opens a Host socket carrying this Deployment's credential. */
export function openReactNativeSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
): WebSocketClient {
  return new WebSocket(url, undefined, { headers });
}
