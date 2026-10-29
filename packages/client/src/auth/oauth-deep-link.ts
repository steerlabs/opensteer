import type { NativeOAuthIdentity } from "./oauth-identity.js";

const maximumQueuedCallbacks = 8;

/**
 * Captures callbacks that arrive before the application is ready to consume
 * them, then serializes delivery to the OAuth manager. It never accepts
 * general custom-scheme URLs: only this build's two registered callbacks.
 */
export class OAuthDeepLinkBroker {
  readonly #oauth: NativeOAuthIdentity;
  readonly #queued: string[] = [];
  #consumer: ((url: string) => Promise<boolean>) | null = null;
  #deliveryTail: Promise<void> = Promise.resolve();

  constructor(oauth: NativeOAuthIdentity) {
    this.#oauth = oauth;
  }

  accept(url: string): boolean {
    if (!isOpensteerOAuthCallback(url, this.#oauth)) return false;
    if (this.#consumer) this.#enqueueDelivery(url);
    else if (this.#queued.length < maximumQueuedCallbacks) this.#queued.push(url);
    return true;
  }

  acceptArguments(arguments_: readonly string[]): boolean {
    let accepted = false;
    for (const argument of arguments_) accepted = this.accept(argument) || accepted;
    return accepted;
  }

  attach(consumer: (url: string) => Promise<boolean>): () => void {
    if (this.#consumer) throw new Error("The OAuth deep-link consumer is already attached.");
    this.#consumer = consumer;
    for (const url of this.#queued.splice(0)) this.#enqueueDelivery(url);
    return () => {
      if (this.#consumer === consumer) this.#consumer = null;
    };
  }

  async settled(): Promise<void> {
    await this.#deliveryTail;
  }

  #enqueueDelivery(url: string): void {
    this.#deliveryTail = this.#deliveryTail
      .then(async () => {
        await this.#consumer?.(url);
      })
      .catch(() => undefined);
  }
}

export function isOpensteerOAuthCallback(rawUrl: string, oauth: NativeOAuthIdentity): boolean {
  if (rawUrl.length > 8_192) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.username || url.password || url.port || url.hash) return false;
  const callback = `${url.protocol}${url.host ? `//${url.host}` : ""}${url.pathname}`;
  return callback === oauth.accountCallback || callback === oauth.hostCallback;
}
