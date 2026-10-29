import { OpensteerError, type TriggerRevisionId } from "@opensteer/core";
import type { TriggerStore } from "@opensteer/database";
import type { TriggerProgram } from "@opensteer/triggers";
import type { WatchControlTokenService } from "./watch-capability.js";

export class WatchProgramService {
  readonly #store: Pick<TriggerStore, "watchProgram">;
  readonly #tokens: Pick<WatchControlTokenService, "authenticate">;

  constructor(options: {
    readonly store: Pick<TriggerStore, "watchProgram">;
    readonly tokens: Pick<WatchControlTokenService, "authenticate">;
  }) {
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  async get(token: string, revisionId: TriggerRevisionId): Promise<TriggerProgram> {
    const claims = await this.#tokens.authenticate(token);
    if (claims.revisionId !== revisionId) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Watch capability does not grant this Trigger revision",
      });
    }
    return this.#store.watchProgram(claims);
  }
}
