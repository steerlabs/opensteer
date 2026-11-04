import { OAuthDeepLinkBroker, type NativeOAuthIdentity } from "@opensteer/client/auth";
import {
  IntegrationAuthorizationAttempts,
  type IntegrationAuthorizationAttempt,
} from "@opensteer/client/integrations";
import {
  parseIntegrationAuthorizationAppReturn,
  type IntegrationAuthorizationAppReturn,
} from "@opensteer/integration-core";
import { IntegrationAuthorizationLoopback } from "./integration-authorization-loopback.js";
import type { DesktopLoginSession } from "./login-session.js";

type Attempt = Pick<IntegrationAuthorizationAttempt, "attemptId" | "deploymentId"> & {
  readonly userId?: string | undefined;
};

/**
 * Main owns the local authority; the bounded OAuth broker holds returns until the
 * owning renderer is ready. The authority lives in memory, so a restarted app
 * refuses earlier attempts and the person starts a fresh one.
 */
export class DesktopIntegrationAuthorizations {
  readonly #attempts = new IntegrationAuthorizationAttempts();
  readonly #broker: OAuthDeepLinkBroker;
  readonly #loopback: IntegrationAuthorizationLoopback;
  readonly #open: (deploymentId: IntegrationAuthorizationAppReturn["deploymentId"]) => void;
  #session: DesktopLoginSession | null = null;
  constructor(
    oauth: NativeOAuthIdentity,
    open: (deploymentId: IntegrationAuthorizationAppReturn["deploymentId"]) => void,
  ) {
    this.#open = open;
    this.#broker = new OAuthDeepLinkBroker(
      oauth,
      (url) => parseIntegrationAuthorizationAppReturn("desktop", url) !== null,
    );
    this.#loopback = new IntegrationAuthorizationLoopback({
      accept: (url) => this.accept(url),
      loginAllowed: () => this.#session?.soleLogin() ?? Promise.resolve(false),
      pendingUntil: () => this.#attempts.latestExpiry(),
    });
  }
  /** Until there is a session to read, attempts use the app link. */
  useLoginSession(session: DesktopLoginSession): () => void {
    this.#session = session;
    const detach = session.subscribe((active) => {
      void this.#loopback.sessionChanged(active);
    });
    return () => {
      this.#session = null;
      detach();
    };
  }
  prepareReturn(deploymentId: string) {
    return this.#loopback.prepare(deploymentId);
  }
  find(attempt: Attempt): IntegrationAuthorizationAttempt | null {
    return this.#attempts.find(attempt);
  }
  async register(entry: IntegrationAuthorizationAttempt, preparation?: string): Promise<void> {
    await this.#attempts.register(entry);
    this.#loopback.registered(preparation);
  }
  async forget(attempt: Attempt): Promise<void> {
    await this.#attempts.forget(attempt);
    this.#loopback.sync();
  }
  async clear(deploymentId?: string): Promise<void> {
    await this.#attempts.clear(deploymentId);
    this.#loopback.release(deploymentId);
  }
  close(): Promise<void> {
    return this.#loopback.close();
  }
  accept(url: string): boolean {
    const callback = parseIntegrationAuthorizationAppReturn("desktop", url);
    if (!callback || !this.#attempts.find(callback)) return false;
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
        const entry = this.#attempts.find(callback);
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
