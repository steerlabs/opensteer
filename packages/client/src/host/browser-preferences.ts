import type { RecentSitesScope, RecentSitesStorage } from "./recent-sites.js";

/** Device-local preference scoped to the signed-in person and deployment. */
export class BrowserPreferences {
  #scope: RecentSitesScope | null = null;
  #enabled = true;
  readonly storage: RecentSitesStorage | undefined;
  constructor(storage?: RecentSitesStorage) {
    this.storage = storage;
  }
  setScope(scope: RecentSitesScope | null): void {
    if (scope?.deploymentId === this.#scope?.deploymentId && scope?.userId === this.#scope?.userId)
      return;
    this.#scope = scope;
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
