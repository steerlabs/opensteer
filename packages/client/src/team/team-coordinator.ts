import {
  ControlPlaneAccountIdSchema,
  type HostAccountAdoptionAuthority,
} from "@opensteer/control-plane-protocol";
import {
  HostedTeamIdSchema,
  type HostedTeamId,
  type HostedTeamSlug,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import {
  DeploymentIdSchema,
  IsoDateTimeSchema,
  TeamOriginSchema,
  type DeploymentId,
  type OpensteerNativeApplication,
  type TeamInviteSecret,
} from "@opensteer/core";
import type { HostCapability } from "@opensteer/deployment-authority";
import type {
  PersonalTeamLink,
  TeamInvitePreviewResponse,
  TeamSessionExchangeRequest,
  TeamSessionExchangeResponse,
} from "@opensteer/protocol";
import { z } from "zod";
import type { AccountTeamsClient } from "./account-teams.js";

/**
 * Where getting a person's agent into a team stands. An offline personal computer is
 * `pending-offline`, never `failed`: the coordinator retries with a fresh link code once it is
 * reachable.
 */
export const TeamConnectionIntentStateSchema = z.enum([
  "connecting",
  "connected",
  "pending-offline",
  "failed",
]);
export type TeamConnectionIntentState = z.infer<typeof TeamConnectionIntentStateSchema>;

/**
 * Persisted per device so a restart resumes the connection. Keyed by Account and team origin;
 * the team Deployment id is null while a hosted team is still being set up.
 */
export const TeamConnectionIntentSchema = z.strictObject({
  accountSubject: ControlPlaneAccountIdSchema,
  teamOrigin: TeamOriginSchema,
  teamDeploymentId: DeploymentIdSchema.nullable(),
  hostedTeamId: HostedTeamIdSchema.nullable(),
  personalDeploymentId: DeploymentIdSchema,
  state: TeamConnectionIntentStateSchema,
  failure: z.string().min(1).max(500).nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type TeamConnectionIntent = z.infer<typeof TeamConnectionIntentSchema>;
export type TeamConnectionIntentKey = Pick<TeamConnectionIntent, "accountSubject" | "teamOrigin">;

export interface TeamConnectionIntentStore {
  load(): Promise<readonly TeamConnectionIntent[]>;
  save(intent: TeamConnectionIntent): Promise<void>;
  remove(key: TeamConnectionIntentKey): Promise<void>;
}

/** A team Host this device reached and verified through its signed discovery. */
export interface VerifiedTeam {
  readonly authority: HostAccountAdoptionAuthority;
  readonly capabilities: readonly HostCapability[];
}

export interface TeamSessionEstablished extends Pick<
  TeamSessionExchangeResponse,
  "admitted" | "member"
> {
  readonly team: VerifiedTeam;
}

/**
 * The device's team credentials: desktop main or mobile secure storage. Tokens are stored behind
 * this port and never returned through it.
 */
export interface TeamSessionPort {
  verify(origin: string, signal?: AbortSignal): Promise<VerifiedTeam>;
  /** `POST /v1/team/session/exchange`; keeps the issued tokens as the team's native credential. */
  exchange(
    team: VerifiedTeam,
    request: TeamSessionExchangeRequest,
    signal?: AbortSignal,
  ): Promise<TeamSessionEstablished>;
  previewInvite(team: VerifiedTeam, invite: TeamInviteSecret): Promise<TeamInvitePreviewResponse>;
  /** `team.link.code.create` with the held session; answers the offer text. */
  createLinkCode(teamDeploymentId: DeploymentId): Promise<string>;
  /** Drops this device's credential and cached state for the team. */
  forget(teamDeploymentId: DeploymentId): Promise<void>;
}

/** The person's own Opensteer that runs their agent (`teams.link.*` on that personal Host). */
export interface PersonalTeamLinksPort {
  join(
    personalDeploymentId: DeploymentId,
    offer: string,
  ): Promise<
    { readonly kind: "joined"; readonly link: PersonalTeamLink } | { readonly kind: "offline" }
  >;
  leave(personalDeploymentId: DeploymentId, teamDeploymentId: DeploymentId): Promise<void>;
}

export interface TeamInvitePreview {
  readonly origin: string;
  /** Null when the team predates invite previews. */
  readonly teamName: string | null;
}

export interface TeamEntered {
  readonly teamDeploymentId: DeploymentId;
  readonly origin: string;
  readonly member: TeamSessionExchangeResponse["member"];
  readonly admitted: boolean;
  readonly intent: TeamConnectionIntent;
}

/** What a coordinator is built from. */
export interface TeamCoordinatorPorts {
  readonly account: AccountTeamsClient;
  readonly sessions: TeamSessionPort;
  readonly personal: PersonalTeamLinksPort;
  readonly intents: TeamConnectionIntentStore;
  readonly surface: OpensteerNativeApplication;
  /** Shows the team, landing in `TeamBootstrap.generalChannelId`. */
  readonly open: (teamDeploymentId: DeploymentId) => void;
}

export interface TeamCoordinatorSnapshot {
  /** Hosted teams this Account is still setting up, has failed to set up, or is deleting. */
  readonly hostedTeams: readonly HostedTeamView[];
  readonly intents: readonly TeamConnectionIntent[];
}

/**
 * One flow for desktop, web shell and mobile: create a hosted team or join with an invite, get a
 * team session without a browser hop, connect the person's agent, and land in #general.
 */
export interface TeamCoordinator {
  getSnapshot(): TeamCoordinatorSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Resolves once Account accepted the team; the coordinator then follows it to ready, enters it
   * as owner, connects the agent and opens #general.
   */
  createHostedTeam(input: {
    readonly name: string;
    readonly slug: HostedTeamSlug;
    readonly personalDeploymentId: DeploymentId;
  }): Promise<HostedTeamView>;
  retryHostedTeam(id: HostedTeamId): Promise<HostedTeamView>;
  /** Cancels setup or deletes the team, and forgets its intent. */
  deleteHostedTeam(id: HostedTeamId): Promise<void>;
  /** What the join confirmation shows; consumes nothing. */
  previewInvite(inviteUrl: string): Promise<TeamInvitePreview>;
  joinWithInvite(input: {
    readonly inviteUrl: string;
    readonly personalDeploymentId: DeploymentId;
  }): Promise<TeamEntered>;
  connectAgent(input: {
    readonly teamDeploymentId: DeploymentId;
    readonly personalDeploymentId: DeploymentId;
  }): Promise<TeamConnectionIntent>;
  /** Revokes only the agent link; membership stays. */
  disconnectAgent(teamDeploymentId: DeploymentId): Promise<void>;
  /** Removes membership, revokes links and clears this device's state. The last owner is refused. */
  leaveTeam(teamDeploymentId: DeploymentId): Promise<void>;
  /** Picks up persisted intents and outstanding hosted teams after launch, resume or sign-in. */
  resume(): Promise<void>;
  dispose(): void;
}
