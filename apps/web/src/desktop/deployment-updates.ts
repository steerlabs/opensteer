import { DesktopUpdatesError, followDesktopUpdates } from "@opensteer/client/settings";
import type { DesktopUpdates } from "@opensteer/client/settings";
import type { DeploymentId } from "@opensteer/core";
import type { DesktopUpdateRequest, DesktopUpdateStatus } from "@opensteer/protocol/maintenance";
import type { DesktopDeploymentUpdatesBridge } from "@opensteer/protocol/desktop";

function unwrap<Data>(
  result:
    | { readonly ok: true; readonly data: Data }
    | { readonly ok: false; readonly failure: DesktopUpdatesError["reason"] },
): Data {
  if (!result.ok) throw new DesktopUpdatesError(result.failure);
  return result.data;
}

/** The desktop app's verified route to one Deployment, held by its main process. */
export class BridgeDesktopUpdates implements DesktopUpdates {
  readonly #bridge: DesktopDeploymentUpdatesBridge;
  readonly #deploymentId: DeploymentId;
  constructor(bridge: DesktopDeploymentUpdatesBridge, deploymentId: DeploymentId) {
    this.#bridge = bridge;
    this.#deploymentId = deploymentId;
  }
  async status(options: { after?: string; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const waitId = globalThis.crypto.randomUUID();
    const cancel = () => void this.#bridge.cancel(waitId).catch(() => undefined);
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.#bridge.status({
        deploymentId: this.#deploymentId,
        waitId,
        ...(options.after === undefined ? {} : { after: options.after }),
      });
      options.signal?.throwIfAborted();
      return unwrap(result);
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  }
  async request(request: DesktopUpdateRequest) {
    return unwrap(await this.#bridge.request({ deploymentId: this.#deploymentId, request }));
  }
  subscribeWhileVisible(
    listener: (status: DesktopUpdateStatus) => void,
    options: { signal: AbortSignal; onError: (error: unknown) => void },
  ): () => void {
    return followDesktopUpdates(this, listener, options);
  }
}
