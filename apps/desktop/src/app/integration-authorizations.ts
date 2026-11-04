import { OAuthDeepLinkBroker, type NativeOAuthIdentity } from "@opensteer/client/auth";
import { IntegrationAuthorizationAttempts } from "@opensteer/client/integrations";
import {
  parseIntegrationAuthorizationAppReturn,
  type IntegrationAuthorizationAppReturn,
} from "@opensteer/integration-core";

/** Main owns the local authority; the bounded OAuth broker holds returns until the owning renderer is ready. */
export class DesktopIntegrationAuthorizations {
  readonly attempts = new IntegrationAuthorizationAttempts();
  readonly #broker: OAuthDeepLinkBroker;
  readonly #open: (deploymentId: IntegrationAuthorizationAppReturn["deploymentId"]) => void;
  constructor(
    oauth: NativeOAuthIdentity,
    open: (deploymentId: IntegrationAuthorizationAppReturn["deploymentId"]) => void,
  ) {
    this.#open = open;
    this.#broker = new OAuthDeepLinkBroker(
      oauth,
      (url) => parseIntegrationAuthorizationAppReturn("desktop", url) !== null,
    );
  }
  accept(url: string): boolean {
    const callback = parseIntegrationAuthorizationAppReturn("desktop", url);
    if (!callback || !this.attempts.find(callback)) return false;
    this.#broker.accept(url);
    this.#open(callback.deploymentId);
    return true;
  }
  attach(
    identity: { readonly deploymentId: string; readonly userId: string },
    receive: (callback: IntegrationAuthorizationAppReturn) => void,
  ): () => void {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;
    let detachBroker: () => void;
    const attach = () => {
      detachBroker = this.#broker.attach(async (url) => {
        const callback = parseIntegrationAuthorizationAppReturn("desktop", url);
        if (!callback) return true;
        const entry = this.attempts.find(callback);
        if (!entry) return true;
        if (
          entry.deploymentId !== identity.deploymentId ||
          (entry.userId !== undefined && entry.userId !== identity.userId)
        )
          return false;
        receive(callback);
        // Emitting an IPC event is not acknowledgement. Keep the proof queued
        // until the renderer confirms a durable terminal outcome.
        if (active && timer === undefined) {
          timer = setTimeout(
            () => {
              timer = undefined;
              if (!active) return;
              detachBroker();
              attach();
            },
            Math.min(delay, Math.max(0, Date.parse(entry.expiresAt) - Date.now())),
          );
          timer.unref?.();
          delay = Math.min(delay * 2, 30_000);
        }
        return false;
      });
    };
    attach();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      detachBroker();
    };
  }

  settled(): Promise<void> {
    return this.#broker.settled();
  }
}
