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
    return this.#broker.attach(async (url) => {
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
      return true;
    });
  }
  settled(): Promise<void> {
    return this.#broker.settled();
  }
}
