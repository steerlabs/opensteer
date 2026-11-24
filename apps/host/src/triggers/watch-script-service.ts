import { OpensteerError, type TriggerRevisionId } from "@opensteer/core";
import type { TriggerStore } from "@opensteer/database";
import type { AutomationScript } from "@opensteer/triggers";
import type { AutomationSecrets } from "./automation-secrets.js";
import type { WatchControlTokenService } from "./watch-capability.js";

export interface WatchScriptPayload {
  readonly script: AutomationScript;
  readonly secrets: Readonly<Record<string, string>>;
}

export class WatchScriptService {
  readonly #secrets: Pick<AutomationSecrets, "values"> | undefined;
  readonly #store: Pick<TriggerStore, "watchScript">;
  readonly #tokens: Pick<WatchControlTokenService, "authenticate">;

  constructor(options: {
    readonly secrets?: Pick<AutomationSecrets, "values">;
    readonly store: Pick<TriggerStore, "watchScript">;
    readonly tokens: Pick<WatchControlTokenService, "authenticate">;
  }) {
    this.#secrets = options.secrets;
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  async get(token: string, revisionId: TriggerRevisionId): Promise<WatchScriptPayload> {
    const claims = await this.#tokens.authenticate(token);
    if (claims.revisionId !== revisionId) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Watch capability does not grant this automation revision",
      });
    }
    const record = await this.#store.watchScript(claims);
    const secrets =
      record.encryptedSecrets && this.#secrets
        ? await this.#secrets.values(record.triggerId, record.encryptedSecrets)
        : {};
    return { script: record.script, secrets };
  }
}
