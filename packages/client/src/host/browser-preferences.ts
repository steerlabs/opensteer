import type { ViewerIdentity } from "./viewer-scope.js";

export interface BrowserPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): readonly string[];
}

/** Device-local preference scoped to the signed-in person and deployment. */
export class BrowserPreferences {
  #scope: ViewerIdentity | null = null;
  #enabled = true;
  readonly storage: BrowserPreferencesStorage | undefined;
  constructor(storage?: BrowserPreferencesStorage) {
    this.storage = storage;
    try {
      for (const key of storage?.keys() ?? [])
        if (
          [
            "opensteer.browsing-history.v2",
            "opensteer.browsing-history.v1",
            "opensteer.recent-sites.v1",
          ].some((prefix) => key.startsWith(prefix))
        )
          storage?.removeItem(key);
    } catch {
      /* Storage can be disabled. */
    }
  }
  setScope(scope: ViewerIdentity | null): void {
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
