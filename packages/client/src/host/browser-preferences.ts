import { z } from "zod";
import type { BrowserIdentityChoice } from "./start-page-model.js";
import type { RecentSitesScope, RecentSitesStorage } from "./recent-sites.js";

/** Device-local preference scoped to the signed-in person and deployment. */
export class BrowserPreferences {
  #scope: RecentSitesScope | null = null;
  #enabled = true;
  #choice: BrowserIdentityChoice | null = null;
  readonly storage: RecentSitesStorage | undefined;
  constructor(storage?: RecentSitesStorage) {
    this.storage = storage;
  }
  setScope(scope: RecentSitesScope | null): void {
    if (scope?.deploymentId === this.#scope?.deploymentId && scope?.userId === this.#scope?.userId)
      return;
    this.#scope = scope;
    this.#choice = null;
    this.#enabled = true;
    try {
      const key = this.#key();
      if (key) this.#enabled = this.storage?.getItem(key) !== "false";
    } catch {
      /* Storage can be disabled by the person. */
    }
  }
  #key(): string | null {
    return this.#scope
      ? `opensteer.search-suggestions.v1:${JSON.stringify([this.#scope.deploymentId, this.#scope.userId])}`
      : null;
  }
  #choiceKey(): string | null {
    return this.#scope
      ? `opensteer.browse-with.v1:${encodeURIComponent(this.#scope.deploymentId)}:${encodeURIComponent(this.#scope.userId)}`
      : null;
  }
  get lastBrowsingChoice(): BrowserIdentityChoice | null {
    try {
      const key = this.#choiceKey();
      const raw = key ? this.storage?.getItem(key) : null;
      if (raw && raw.length <= 512)
        return z
          .discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("profile"), profileId: z.string().min(1).max(200) }),
            z.strictObject({ kind: z.literal("guest") }),
          ])
          .parse(JSON.parse(raw));
    } catch {
      /* A preference never prevents opening. */
    }
    return this.#choice;
  }
  set lastBrowsingChoice(choice: BrowserIdentityChoice | null) {
    this.#choice = choice;
    try {
      const key = this.#choiceKey();
      if (key) {
        if (choice) this.storage?.setItem(key, JSON.stringify(choice));
        else this.storage?.removeItem(key);
      }
    } catch {
      /* The in-memory choice still applies. */
    }
  }
  get showSearchSuggestions(): boolean {
    return this.#enabled;
  }
  set showSearchSuggestions(enabled: boolean) {
    this.#enabled = enabled;
    try {
      const key = this.#key();
      if (key) this.storage?.setItem(key, String(enabled));
    } catch {
      /* The in-memory preference still applies for this session. */
    }
  }
}
