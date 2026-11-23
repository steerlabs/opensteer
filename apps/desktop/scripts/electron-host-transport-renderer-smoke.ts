import { classifyClientFailure } from "@opensteer/client/connections";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import { createId, DeploymentIdSchema } from "@opensteer/core";
import { includeDeviceAccessRequests } from "@opensteer/protocol";
import { desktopBridge } from "../../web/src/desktop/desktop-bridge.js";
import { createDesktopHostFetch } from "../../web/src/desktop/desktop-host-transport.js";

declare global {
  interface Window {
    hostTransportSmoke: (
      origin: string,
      deploymentId: string,
      action: "rpc" | "abort-start" | "abort-finish" | "binary" | "attention",
    ) => Promise<unknown>;
  }
}

let held: { readonly abort: () => void; readonly outcome: Promise<unknown> } | null = null;

window.hostTransportSmoke = async (origin, deploymentId, action) => {
  const bridge = desktopBridge();
  if (!bridge) throw new Error("The desktop preload bridge is missing.");
  const fetch = createDesktopHostFetch(bridge, origin, DeploymentIdSchema.parse(deploymentId));
  // Started here and aborted only once main's Host has the request and has sent no headers.
  if (action === "abort-start") {
    const controller = new AbortController();
    const reason = new DOMException("Caller stopped this request.", "AbortError");
    held = {
      abort: () => controller.abort(reason),
      outcome: fetch(`${origin}/v1/withheld?renderer=1`, { signal: controller.signal }).then(
        () => {
          throw new Error("Caller abort was ignored.");
        },
        (error: unknown) => {
          if (error !== reason) throw error;
          return { callerReasonPreserved: true };
        },
      ),
    };
    return null;
  }
  if (action === "abort-finish") {
    if (!held) throw new Error("No request is being held.");
    const { abort, outcome } = held;
    held = null;
    abort();
    return outcome;
  }
  const client = createHttpHostApiClient({
    baseUrl: new URL(origin),
    fetch,
    onAuthenticationRequired: () => undefined,
  });
  // The switcher's summary read of a Home, pinned to that Home whether or not it is selected.
  if (action === "attention") return client["attention.get"](includeDeviceAccessRequests);
  if (action === "binary") {
    const result = await client["attachment.content"]({ attachmentId: createId("attachment") });
    if (result.ok) throw new Error("Oversized binary response was accepted.");
    return { code: result.error.reason, retryable: result.error.retryable };
  }
  // A cancelled request rejects rather than becoming the Host's answer.
  return client["auth.config"]({}).catch((error: unknown) => ({
    rejected: classifyClientFailure(error),
  }));
};
