import { randomUUID } from "node:crypto";
import { parseTeamPageAppLink, teamPageUrl } from "@opensteer/core";
import type { DesktopTeamLink } from "@opensteer/protocol/desktop";

/** Invite verifiers remain in memory until the application renderer acknowledges them. */
export class DesktopTeamLinks {
  readonly #scheme: string;
  readonly #pending: DesktopTeamLink[] = [];
  #consumer: ((link: DesktopTeamLink) => void) | null = null;
  #sent: string | null = null;

  constructor(scheme: string) {
    this.#scheme = scheme;
  }

  accept(value: string): boolean {
    const link = parseTeamPageAppLink(value, this.#scheme);
    if (!link) return false;
    const url = teamPageUrl(link);
    if (this.#pending.some((pending) => pending.url === url)) return true;
    if (this.#pending.length >= 20) return false;
    this.#pending.push({ id: randomUUID(), url });
    this.#deliver();
    return true;
  }

  attach(consumer: (link: DesktopTeamLink) => void): () => void {
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

  acknowledge(id: string): void {
    if (this.#sent !== id || this.#pending[0]?.id !== id) return;
    this.#pending.shift();
    this.#sent = null;
    this.#deliver();
  }

  #deliver(): void {
    const next = this.#pending[0];
    if (!next || !this.#consumer || this.#sent) return;
    this.#sent = next.id;
    this.#consumer(next);
  }
}
