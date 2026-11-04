import type { NativeOAuthIdentity } from "./oauth-identity.js";

const maximumQueuedCallbacks = 8;

/**
 * Captures callbacks that arrive before the application is ready to consume
 * them, then serializes delivery to the OAuth manager. It never accepts
 * general custom-scheme URLs: only registered callbacks explicitly admitted by the app.
 */
export class OAuthDeepLinkBroker {
  readonly #oauth: NativeOAuthIdentity;
  readonly #acceptAdditional: (url: string) => boolean;
  readonly #queued: string[] = [];
  #consumer: ((url: string) => Promise<boolean>) | null = null;
  #deliveryTail: Promise<void> = Promise.resolve();

  constructor(
    oauth: NativeOAuthIdentity,
    acceptAdditional: (url: string) => boolean = () => false,
  ) {
    this.#oauth = oauth;
    this.#acceptAdditional = acceptAdditional;
  }

  accept(url: string): boolean {
    if (!isOpensteerOAuthCallback(url, this.#oauth) && !this.#acceptAdditional(url)) return false;
    if (this.#consumer) this.#enqueueDelivery(url);
    else this.#queue(url);
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
        const consumer = this.#consumer;
        if (!consumer || !(await consumer(url))) this.#queue(url);
      })
      .catch(() => undefined);
  }

  #queue(url: string): void {
    if (this.#queued.length < maximumQueuedCallbacks && !this.#queued.includes(url))
      this.#queued.push(url);
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
