import { isLoopbackHostname } from "@opensteer/core";
import type { BrowserAttachTicketIdentity } from "@opensteer/protocol";
import { BrowserRuntimeError } from "./errors.js";

export type NativeProfileReady = (
  identity: Extract<BrowserAttachTicketIdentity, { kind: "profile-local" }>,
  ticket: string,
  signal: AbortSignal,
) => Promise<void>;

export function nativeProfileReadyClient(trustedHttpOrigin?: string): NativeProfileReady {
  return async (identity, ticket, signal) => {
    const url = new URL(identity.readyUrl);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          (isLoopbackHostname(url.hostname) || url.origin === trustedHttpOrigin)
        ))
    )
      throw new BrowserRuntimeError(
        "forbidden",
        "The native profile readiness address is invalid.",
      );
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
      redirect: "error",
      signal,
    });
    void response.body?.cancel().catch(() => undefined);
    if (!response.ok)
      throw new BrowserRuntimeError(
        "conflict",
        "The Host did not acknowledge native profile readiness.",
      );
  };
}
export const acknowledgeNativeProfileReady = nativeProfileReadyClient();
