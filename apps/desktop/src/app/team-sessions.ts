import {
  NativeTeamEntry,
  assertTeamEntryOutcome,
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
        return verifiedTeam(verified);
      }
      case "preview-invite":
        return previewTeamInvite(call.origin, call.invite, this.#fetch);
      case "enter":
      case "sign-in": {
        const outcome = await this.#entry.authorize({
          deploymentId: call.deploymentId,
          origin: call.origin,
          mode: "interactive",
          invite: call.invite,
        });
        assertTeamEntryOutcome(outcome);
        if (call.call === "sign-in") return null;
        if (outcome.status === "authorized" && outcome.member)
          return { admitted: outcome.admitted, member: outcome.member };
        return this.#entry.bootstrap(call.deploymentId);
      }
      case "restore":
        await this.#entry.restore(call.deploymentId, call.origin);
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
