import type { CdpSession } from "@opensteer/browser-runtime-core";
import { withTimeout } from "@opensteer/shared/withTimeout";

export async function loadPage(
  cdp: CdpSession,
  method: "Page.navigate" | "Page.reload",
  parameters: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  const loaded = Promise.withResolvers<void>();
  const onLoad = () => loaded.resolve();
  cdp.on("Page.loadEventFired", onLoad);
  try {
    await withTimeout(Promise.all([cdp.send(method, parameters), loaded.promise]), 5_000, {
      signal,
      timeoutError: () => new Error(`Chromium ${method} never finished loading within 5,000 ms.`),
    });
  } finally {
    cdp.off("Page.loadEventFired", onLoad);
  }
}
