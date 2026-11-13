import {
  ClientOperationError,
  classifyClientFailure,
  type PrivateFilesystem,
  type VerifiedHostEndpoint,
} from "@opensteer/client/connections";
import {
  HostClientRequestError,
  PersonalTeamLinks,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import {
  previewTeamInvite,
  revokeOwnAgentLinks,
  TeamConnectionIntentSchema,
  verifiedTeam,
  type PersonalTeamLinksPort,
  type TeamConnectionIntent,
  type TeamConnectionIntentStore,
  type TeamSessionPort,
  type VerifiedTeam,
} from "@opensteer/client/team";
import { teamPageUrl, type TeamInviteSecret } from "@opensteer/core";
import { z } from "zod";
import type { MobileTeams } from "./mobile-teams.js";

const IntentFileSchema = z.object({
  schemaVersion: z.literal(1),
  intents: z.array(z.unknown()).max(200),
});

/**
 * Where getting the person's agent into each team stands, on this phone. A row
 * that no longer parses is dropped, never the file: one bad intent costs that
 * team's resume, not every team's.
 */
export function fileTeamIntentStore(
  files: PrivateFilesystem,
  path: string,
): TeamConnectionIntentStore {
  let held: TeamConnectionIntent[] | null = null;
  let writing: Promise<void> = Promise.resolve();
  const load = async (): Promise<TeamConnectionIntent[]> => {
    if (held !== null) return held;
    const stored = await files.readFile(path, 256 * 1024).catch(() => null);
    let rows: TeamConnectionIntent[] = [];
    if (stored !== null) {
      try {
        const parsed = IntentFileSchema.safeParse(JSON.parse(new TextDecoder().decode(stored)));
        if (parsed.success)
          rows = parsed.data.intents.flatMap((row) => {
            const intent = TeamConnectionIntentSchema.safeParse(row);
            return intent.success ? [intent.data] : [];
          });
      } catch {
        // Unreadable: nothing to resume.
      }
    }
    held ??= rows;
    return held;
  };
  const same = (
    a: TeamConnectionIntent,
    b: Pick<TeamConnectionIntent, "accountSubject" | "teamOrigin">,
  ) => a.accountSubject === b.accountSubject && a.teamOrigin === b.teamOrigin;
  const persist = (): Promise<void> => {
    const snapshot = JSON.stringify({ schemaVersion: 1, intents: held ?? [] });
    // Writes land in the order they were made, so an older one never wins.
    writing = writing.catch(() => undefined).then(() => files.writeFileAtomic(path, snapshot));
    return writing;
  };
  return {
    load: async () => [...(await load())],
    save: async (intent) => {
      const rows = await load();
      const parsed = TeamConnectionIntentSchema.parse(intent);
      const index = rows.findIndex((row) => same(row, parsed));
      if (index === -1) rows.push(parsed);
      else rows[index] = parsed;
      await persist();
    },
    remove: async (key) => {
      const rows = await load();
      held = rows.filter((row) => !same(row, key));
      await persist();
    },
  };
}

/**
 * Whether a failed call to the person's own Opensteer means it is out of reach
 * (their agent connects later) rather than that it refused.
 */
export function personalUnreachable(error: unknown): boolean {
  if (error instanceof HostClientRequestError)
    return error.code === "timeout" || error.code === "runner_offline" || error.status >= 500;
  return classifyClientFailure(error).classification === "transient";
}

/**
 * The person's own Opensteer that runs their agent: the computer this phone is
 * showing. Any other computer, or this one while it doesn't answer, is offline
 * for now; the coordinator tries again with a fresh code.
 */
export function mobilePersonalTeamLinks(
  personal: (deploymentId: string) => HostClient | null,
): PersonalTeamLinksPort {
  return {
    async join(personalDeploymentId, offer) {
      const host = personal(personalDeploymentId);
      if (host === null) return { kind: "offline" };
      try {
        return { kind: "joined", link: await new PersonalTeamLinks(host.rpc).join(offer) };
      } catch (error) {
        if (personalUnreachable(error)) return { kind: "offline" };
        throw error;
      }
    },
    async leave(personalDeploymentId, teamDeploymentId) {
      const host = personal(personalDeploymentId);
      if (host === null)
        throw new ClientOperationError(
          "That computer isn’t reachable from this phone.",
          "transient",
        );
      await new PersonalTeamLinks(host.rpc).leave(teamDeploymentId);
    },
  };
}

/** The team side of the coordinator on a phone, over the teams it already holds. */
export function mobileTeamSessions(options: {
  readonly teams: MobileTeams;
  readonly fetch: typeof globalThis.fetch;
  /** The system browser, whose cookies the team's sign-in shares afterwards. */
  readonly openUrl: (url: string) => Promise<unknown>;
}): TeamSessionPort {
  const { teams } = options;
  const verified = new Map<string, VerifiedHostEndpoint>();
  return {
    async verify(origin) {
      const endpoint = await teams.verifyTeam(origin);
      verified.set(origin, endpoint);
      return verifiedTeam(endpoint);
    },
    async exchange(team, invite) {
      const origin = team.authority.canonicalOrigin;
      const endpoint = verified.get(origin) ?? (await teams.verifyTeam(origin));
      return { ...(await teams.enter(endpoint, invite)), team };
    },
    restore: ({ origin, teamDeploymentId }) => teams.restore(origin, teamDeploymentId),
    async signIn(team: VerifiedTeam, invite: TeamInviteSecret | null) {
      const origin = team.authority.canonicalOrigin;
      const endpoint = verified.get(origin) ?? (await teams.verifyTeam(origin));
      const member = await teams.signIn(endpoint, invite);
      return { admitted: invite !== null, member, team };
    },
    async joinInBrowser(team, invite) {
      await options.openUrl(
        teamPageUrl({
          origin: team.authority.canonicalOrigin,
          target: { kind: "invite", ...invite },
        }),
      );
    },
    previewInvite: (team, invite) =>
      previewTeamInvite(team.authority.canonicalOrigin, invite, options.fetch),
    revokeAgentLinks: async (teamDeploymentId) =>
      revokeOwnAgentLinks((await teams.session(teamDeploymentId)).rpc),
    async createLinkCode(teamDeploymentId) {
      const session = await teams.session(teamDeploymentId);
      const minted = unwrapRpcResult(
        await session.rpc["commands.dispatch"]({ type: "team.link.code.create" }),
      );
      if (minted.type !== "team.link.code.create") throw new Error("The team did not make a code.");
      return minted.offer;
    },
    // Membership first (the team refuses its last owner), then this phone's copy of the team.
    leave: (teamDeploymentId) => teams.leave(teamDeploymentId),
    forget: (teamDeploymentId) => teams.forget(teamDeploymentId),
  };
}
