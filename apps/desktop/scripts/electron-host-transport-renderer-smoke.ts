import { createHttpHostApiClient } from "@opensteer/client/host-api";
import { HostTransportError } from "@opensteer/client/connections";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { createDesktopHostFetch } from "../../web/src/desktop/desktop-host-transport.js";

declare global {
  interface Window {
    hostTransportSmoke: (origin: string, action: "rpc" | "abort" | "binary") => Promise<unknown>;
  }
}

window.hostTransportSmoke = async (origin, action) => {
  const bridge = Reflect.get(window, "opensteerDesktop") as OpensteerDesktopBridge;
  const fetch = createDesktopHostFetch(
    {
      ...bridge,
      hostRequest: (input) => bridge.hostRequest({ ...input, timeoutMs: 500 }),
    },
    origin,
  );
  if (action === "abort") {
    const controller = new AbortController();
    const reason = new DOMException("Caller stopped this request.", "AbortError");
    const pending = fetch(`${origin}/v1/stall?renderer=1`, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 30);
    try {
      await pending;
      throw new Error("Caller abort was ignored.");
    } catch (error) {
      if (error !== reason) throw error;
      return { callerReasonPreserved: true };
    }
  }
  if (action === "binary") {
    try {
      const response = await fetch(`${origin}/v1/rpc/attachment.content?input=%7B%7D`);
      await response.arrayBuffer();
      throw new Error("Oversized binary response was accepted.");
    } catch (error) {
      if (!(error instanceof HostTransportError)) throw error;
      return { code: error.code, retryable: error.retryable };
    }
  }
  return createHttpHostApiClient({
    baseUrl: new URL(origin),
    fetch,
    onAuthenticationRequired: () => undefined,
  })["auth.config"]({});
};
