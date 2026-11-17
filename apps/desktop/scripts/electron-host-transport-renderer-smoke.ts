import { createHttpHostApiClient } from "@opensteer/client/host-api";
import { createId, DeploymentIdSchema } from "@opensteer/core";
import { createDesktopHostFetch } from "../../web/src/desktop/desktop-host-transport.js";

declare global {
  interface Window {
    hostTransportSmoke: (
      origin: string,
      deploymentId: string,
      action: "rpc" | "abort" | "binary",
    ) => Promise<unknown>;
  }
}

window.hostTransportSmoke = async (origin, deploymentId, action) => {
  const fetch = createDesktopHostFetch(origin, DeploymentIdSchema.parse(deploymentId));
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
  const client = createHttpHostApiClient({
    baseUrl: new URL(origin),
    fetch,
    onAuthenticationRequired: () => undefined,
  });
  if (action === "binary") {
    const result = await client["attachment.content"]({ attachmentId: createId("attachment") });
    if (result.ok) throw new Error("Oversized binary response was accepted.");
    return { code: result.error.reason, retryable: result.error.retryable };
  }
  return client["auth.config"]({});
};
