import type { VerifiedHostEndpoint } from "@opensteer/client/connections";
import {
  NativeTeamEntry,
  previewTeamInvite,
  verifiedTeam,
  verifyTeamEndpoint,
} from "@opensteer/client/team";
import type { DesktopTeamSessionsCall } from "@opensteer/protocol/desktop";

/**
 * Entering teams for the application window. The Account identity grant and the team's tokens
 * are made and kept here; the renderer gets only who the person is on the team.
 */
export class DesktopTeamSessions {
  readonly #entry: NativeTeamEntry;
  readonly #fetch: typeof globalThis.fetch;
  /** The discovery a `verify` just checked, used by the `enter` that follows it. */
  readonly #verified = new Map<string, VerifiedHostEndpoint>();

  constructor(options: {
    readonly entry: NativeTeamEntry;
    readonly fetch: typeof globalThis.fetch;
  }) {
    this.#entry = options.entry;
    this.#fetch = options.fetch;
  }

  async run(call: DesktopTeamSessionsCall): Promise<unknown> {
    switch (call.call) {
      case "verify": {
        const verified = await this.#verify(call.origin);
        if (this.#verified.size >= 20) this.#verified.clear();
        this.#verified.set(call.origin, verified);
        return verifiedTeam(verified);
      }
      case "preview-invite":
        return previewTeamInvite(call.origin, call.invite, this.#fetch);
      case "enter": {
        const verified = this.#verified.get(call.origin) ?? (await this.#verify(call.origin));
        this.#verified.delete(call.origin);
        return this.#entry.enter(verified, call.invite);
      }
      case "restore":
        await this.#entry.restore(call.deploymentId, () => this.#verify(call.origin));
        return null;
      case "forget":
        await this.#entry.forget(call.deploymentId);
        return null;
    }
  }

  #verify(origin: string) {
    return verifyTeamEndpoint(origin, { fetch: this.#fetch });
  }
}
