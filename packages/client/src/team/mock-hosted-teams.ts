import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  HostedTeamSlugSchema,
  HostedTeamViewSchema,
  hostedTeamOrigin,
  reservedHostedTeamSlugs,
  type HostedTeamAvailability,
  type HostedTeamId,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import {
  createId,
  DeploymentIdSchema,
  OpensteerError,
  UserIdSchema,
  type DeploymentId,
  type TeamInviteSecret,
} from "@opensteer/core";
import { TeamEntryRefusedError } from "../auth/native-oauth.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import type { AccountTeamsClient } from "./account-teams.js";
import { MockTeamHost } from "./mock-team-host.js";
import type {
  PersonalTeamLinksPort,
  TeamConnectionIntent,
  TeamConnectionIntentStore,
  TeamSessionPort,
  VerifiedTeam,
} from "./team-coordinator.js";

export const mockAccountSubject = ControlPlaneAccountIdSchema.parse(
  "acct_00000000-0000-4000-8000-0000000000aa",
);
export const mockAccountEmail = "you@example.com";
const mockUserId = UserIdSchema.parse("usr_00000000-0000-4000-8000-0000000000ab");

/** How long each setup stage lasts in the mock, in ms. */
const stages = { reserving: 1_100, starting: 1_300, configuring: 1_000 } as const;

interface MockHostedTeam {
  view: Omit<HostedTeamView, "stage" | "error">;
  startedAt: number;
  /** `fail…` addresses fail their first setup, so Retry can be exercised. */
  failsOnce: boolean;
  deleted: boolean;
}

interface MockTeamRecord {
  readonly verified: VerifiedTeam;
  readonly name: string;
  readonly hostedTeamId: HostedTeamId | null;
  /** The person's own view of the team once they hold a session. */
  host: MockTeamHost | null;
  /** The invite a non-member may join with. */
  readonly invite: TeamInviteSecret | null;
}

const fingerprint = (seed: string) =>
  `sha256:${(seed.replaceAll(/[^A-Za-z0-9]/gu, "") + "x".repeat(43)).slice(0, 43)}`;

/**
 * The hosted-teams world mock mode runs against: Account creating teams through real stages, team
 * Hosts admitting the person by session exchange or invite, and their own Opensteer that can be
 * switched off. Every port the `TeamCoordinator` needs, in memory.
 */
export class MockTeamWorld {
  readonly #teams = new Map<HostedTeamId, MockHostedTeam>();
  readonly #records = new Map<string, MockTeamRecord>();
  readonly #listeners = new Set<() => void>();
  readonly #intents: TeamConnectionIntent[] = [];
  #joined: readonly MockTeamHost[] = [];
  /** The person's own Opensteer: off, joins wait as pending. */
  personalOnline = true;
  readonly sampleInviteUrl: string;
  /** Multiplies every setup stage; 0 makes a new team ready at once. */
  readonly #pace: number;

  constructor(options: { readonly pace?: number } = {}) {
    this.#pace = options.pace ?? 1;
    const invite = {
      selector: "Zq4tR8sampleInviteSelector00",
      verifier: "sampleInviteVerifierZq4tR8aaaaaaaa",
    };
    const origin = "https://northwind.teams.opensteer.com";
    this.sampleInviteUrl = `${origin}/invite/${invite.selector}#${invite.verifier}`;
    this.#records.set(origin, {
      verified: this.#verified(origin, DeploymentIdSchema.parse(createId("deployment"))),
      name: "Northwind",
      hostedTeamId: null,
      host: null,
      invite,
    });
  }

  readonly accountSubject = (): ControlPlaneAccountId => mockAccountSubject;

  /** Teams the person holds a session in, newest last. */
  joined(): readonly MockTeamHost[] {
    return this.#joined;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(): void {
    this.#joined = [...this.#records.values()].flatMap((record) =>
      record.host && record.host.bootstrap.member.state === "active" ? [record.host] : [],
    );
    for (const listener of this.#listeners) listener();
  }

  #verified(origin: string, deploymentId: DeploymentId): VerifiedTeam {
    return {
      authority: {
        deploymentId,
        hostInstanceId: createId("hostInstance"),
        canonicalOrigin: origin,
        hostKeyFingerprint: fingerprint(deploymentId),
      },
      capabilities: ["team-session-exchange-v1", "team-reusable-invites-v1"],
    };
  }

  #view(team: MockHostedTeam): HostedTeamView {
    const elapsed = this.#pace === 0 ? Infinity : (Date.now() - team.startedAt) / this.#pace;
    const stage = team.deleted
      ? "deleting"
      : elapsed < stages.reserving
        ? "reserving"
        : elapsed < stages.reserving + stages.starting
          ? "starting"
          : team.failsOnce
            ? "failed"
            : elapsed < stages.reserving + stages.starting + stages.configuring
              ? "configuring"
              : "ready";
    if (stage === "ready" && !this.#records.has(team.view.origin))
      this.#records.set(team.view.origin, {
        verified: this.#verified(team.view.origin, team.view.deploymentId!),
        name: team.view.name,
        hostedTeamId: team.view.id,
        host: null,
        invite: null,
      });
    return HostedTeamViewSchema.parse({
      ...team.view,
      stage,
      ...(stage === "failed"
        ? { error: { message: "The team server didn’t start. Try again." } }
        : {}),
    });
  }

  readonly account: AccountTeamsClient = {
    hostedTeamAvailability: async (slug): Promise<HostedTeamAvailability> => {
      if (reservedHostedTeamSlugs.has(slug)) return { available: false, reason: "reserved" };
      if (!HostedTeamSlugSchema.safeParse(slug).success)
        return { available: false, reason: "invalid" };
      const taken =
        slug === "taken" ||
        [...this.#teams.values()].some((team) => !team.deleted && team.view.slug === slug) ||
        this.#records.has(hostedTeamOrigin(slug));
      return taken ? { available: false, reason: "taken" } : { available: true };
    },
    createHostedTeam: async (request) => {
      const replay = [...this.#teams.values()].find((team) => team.view.id === request.requestId);
      if (replay) return this.#view(replay);
      const availability = await this.account.hostedTeamAvailability(request.slug);
      if (!availability.available)
        throw new OpensteerError({
          code: "conflict",
          message: "Someone already uses that address.",
          reason: "hosted-team-address-taken",
        });
      const id = request.requestId as HostedTeamId;
      const team: MockHostedTeam = {
        view: {
          id,
          name: request.name,
          slug: request.slug,
          origin: hostedTeamOrigin(request.slug),
          deploymentId: DeploymentIdSchema.parse(createId("deployment")),
        },
        startedAt: Date.now(),
        failsOnce: request.slug.startsWith("fail"),
        deleted: false,
      };
      this.#teams.set(id, team);
      return this.#view(team);
    },
    listHostedTeams: async () =>
      [...this.#teams.values()].filter((team) => !team.deleted).map((team) => this.#view(team)),
    hostedTeam: async (id) => {
      const team = this.#teams.get(id);
      if (!team) return null;
      if (team.deleted) {
        this.#teams.delete(id);
        return null;
      }
      return this.#view(team);
    },
    retryHostedTeam: async (id) => {
      const team = this.#teams.get(id);
      if (!team) throw new OpensteerError({ code: "not_found", message: "That team is gone." });
      team.failsOnce = false;
      team.startedAt = Date.now() - stages.reserving;
      return this.#view(team);
    },
    deleteHostedTeam: async (id) => {
      const team = this.#teams.get(id);
      if (!team) return null;
      team.deleted = true;
      const record = this.#records.get(team.view.origin);
      this.#records.delete(team.view.origin);
      if (record?.host) record.host.dispose();
      this.#publish();
      return this.#view(team);
    },
  };

  #record(teamDeploymentId: DeploymentId): MockTeamRecord {
    const record = [...this.#records.values()].find(
      (candidate) => candidate.verified.authority.deploymentId === teamDeploymentId,
    );
    if (!record?.host)
      throw new OpensteerError({ code: "unauthorized", message: "Sign in to the team first." });
    return record;
  }

  readonly sessions: TeamSessionPort = {
    verify: async (origin) => {
      const record = this.#records.get(origin);
      if (!record) throw new TypeError(`${new URL(origin).host} can’t be reached.`);
      return record.verified;
    },
    exchange: async (team, invite) => {
      const record = this.#records.get(team.authority.canonicalOrigin);
      if (!record) throw new TypeError("The team can’t be reached.");
      let admitted = false;
      if (!record.host) {
        const owner = record.hostedTeamId !== null;
        if (!owner) {
          if (
            !invite ||
            !record.invite ||
            invite.selector !== record.invite.selector ||
            invite.verifier !== record.invite.verifier
          )
            throw new TeamEntryRefusedError(
              "invite-invalid",
              "This invite no longer works. Ask for a new one.",
            );
          admitted = true;
        }
        record.host = new MockTeamHost({
          teamId: team.authority.deploymentId,
          userId: mockUserId,
          teamName: record.name,
          origin: record.verified.authority.canonicalOrigin,
          role: owner ? "owner" : "member",
          displayName: "You",
          hostedTeamId: record.hostedTeamId,
        });
        this.#publish();
      }
      return { admitted, member: record.host.bootstrap.member, team: record.verified };
    },
    previewInvite: async (team, invite) => {
      const record = this.#records.get(team.authority.canonicalOrigin);
      if (!record?.invite || record.invite.verifier !== invite.verifier)
        throw new TeamEntryRefusedError(
          "invite-invalid",
          "This invite no longer works. Ask for a new one.",
        );
      return {
        teamName: record.name,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      };
    },
    restore: async ({ origin }) => {
      const record = this.#records.get(origin);
      if (!record?.host)
        throw new TeamEntryRefusedError("not-a-member", "You're not a member of this team.");
    },
    createLinkCode: async (teamDeploymentId) => {
      const result = unwrapRpcResult(
        await this.#record(teamDeploymentId).host!.rpc["commands.dispatch"]({
          type: "team.link.code.create",
        }),
      );
      if (result.type !== "team.link.code.create") throw new Error("The team made no code.");
      return result.offer;
    },
    leave: async (teamDeploymentId) => {
      const host = this.#record(teamDeploymentId).host!;
      unwrapRpcResult(
        await host.rpc["commands.dispatch"]({ type: "team.member.remove", userId: host.userId }),
      );
    },
    forget: async (teamDeploymentId) => {
      const record = [...this.#records.values()].find(
        (candidate) => candidate.verified.authority.deploymentId === teamDeploymentId,
      );
      if (!record?.host) return;
      record.host.dispose();
      record.host = null;
      this.#publish();
    },
  };

  readonly personal: PersonalTeamLinksPort = {
    join: async (_personal, offer) => {
      if (!this.personalOnline) return { kind: "offline" };
      const origin = [...this.#records.keys()].find((candidate) =>
        offer.includes(new URL(candidate).host),
      );
      const record = origin ? this.#records.get(origin) : undefined;
      if (!record) throw new Error("That code isn’t for a team you’re in.");
      return {
        kind: "joined",
        link: {
          teamId: record.verified.authority.deploymentId,
          hostInstanceId: record.verified.authority.hostInstanceId,
          origin: record.verified.authority.canonicalOrigin,
          teamName: record.name,
          remoteLinkId: null,
          ownerUserId: mockUserId,
          state: "active",
          updateRequiredBy: null,
          lastContactAt: new Date().toISOString(),
        },
      };
    },
    leave: async () => undefined,
  };

  readonly intents: TeamConnectionIntentStore = {
    load: async () => [...this.#intents],
    save: async (intent) => {
      const index = this.#intents.findIndex(
        (held) =>
          held.accountSubject === intent.accountSubject && held.teamOrigin === intent.teamOrigin,
      );
      if (index === -1) this.#intents.push(intent);
      else this.#intents[index] = intent;
    },
    remove: async (key) => {
      const index = this.#intents.findIndex(
        (held) => held.accountSubject === key.accountSubject && held.teamOrigin === key.teamOrigin,
      );
      if (index !== -1) this.#intents.splice(index, 1);
    },
  };
}
