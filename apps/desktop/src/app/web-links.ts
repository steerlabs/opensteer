import { randomUUID } from "node:crypto";
import {
  DesktopWebUrlSchema,
  type DesktopWebLink,
  type DesktopWebLinkRequest,
} from "@opensteer/protocol/desktop";

/** Retained until acknowledged; stable ids also fence Host retries across renderer reloads. */
export class DesktopWebLinks {
  readonly #pending: DesktopWebLink[] = [];
  readonly #notice: (message: string) => void;
  #consumer: ((link: DesktopWebLink) => void) | null = null;
  #sent: string | null = null;
  #recent = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(notice: (message: string) => void) {
    this.#notice = notice;
  }
  get pending(): boolean {
    return this.#pending.length > 0;
  }
  accept(raw: string): boolean {
    if (!DesktopWebUrlSchema.safeParse(raw).success) return false;
    const now = Date.now();
    for (const [url, at] of this.#recent) if (now - at > 1000) this.#recent.delete(url);
    if (this.#recent.has(raw)) return true;
    if (this.#pending.length >= 20) {
      this.#notice(
        "Opensteer is holding 20 web links. Additional links were not opened; please open them again after Personal is ready.",
      );
      return true;
    }
    this.#recent.set(raw, now);
    this.#pending.push({ type: "open-web-url", id: randomUUID(), url: raw });
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      if (this.#pending.length)
        this.#notice(
          "Web links are waiting. Open your signed-in Personal deployment to open them in its browser.",
        );
    }, 15000);
    this.#deliver();
    return true;
  }
  attach(consumer: (link: DesktopWebLink) => void): () => void {
    this.#consumer = consumer;
    this.#sent = null;
    this.#deliver();
    return () => {
      if (this.#consumer === consumer) {
        this.#consumer = null;
        this.#sent = null;
      }
    };
  }
  bind(id: string, request: DesktopWebLinkRequest): DesktopWebLink | null {
    const link = this.#pending[0];
    if (!link || link.id !== id || this.#sent !== id) return null;
    if (
      link.request &&
      (link.request.deploymentId !== request.deploymentId || link.request.userId !== request.userId)
    )
      return null;
    const bound = { ...link, request: link.request ?? structuredClone(request) };
    this.#pending[0] = bound;
    return structuredClone(bound);
  }
  acknowledge(id: string): void {
    if (id !== this.#sent || this.#pending[0]?.id !== id) return;
    this.#pending.shift();
    this.#sent = null;
    if (!this.#pending.length) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#deliver();
  }
  dispose(): void {
    clearTimeout(this.#timer);
    this.#consumer = null;
  }
  #deliver(): void {
    const next = this.#pending[0];
    if (!next || !this.#consumer || this.#sent) return;
    this.#sent = next.id;
    this.#consumer(next);
  }
}

export function routeDesktopUrl(
  url: string,
  oauth: { accept(url: string): boolean },
  web: DesktopWebLinks,
): boolean {
  return oauth.accept(url) || web.accept(url);
}
