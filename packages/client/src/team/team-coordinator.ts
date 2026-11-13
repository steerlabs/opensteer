import { teamEntryRefusalOutcome } from "@opensteer/protocol";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
  type HostAccountAdoptionAuthority,
} from "@opensteer/control-plane-protocol";
import {
  HostedTeamIdSchema,
  hostedTeamOrigin,
  type HostedTeamId,
  type HostedTeamSlug,
  type HostedTeamOwner,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import {
  DeploymentIdSchema,
  IsoDateTimeSchema,
  parseTeamPageLink,
  TeamOriginSchema,
  type DeploymentId,
  type TeamInviteSecret,
} from "@opensteer/core";
import type { HostCapability } from "@opensteer/deployment-authority";
import type {
  HostApiClient,
  PersonalTeamLink,
  TeamInvitePreviewResponse,
  TeamSessionExchangeResponse,
} from "@opensteer/protocol";
import { TeamEntryRefusedError, TeamIdentityGrantUnsupportedError } from "../auth/native-oauth.js";
import { delay } from "@opensteer/shared/delay";
import { z } from "zod";
import type { AccountTeamsClient } from "./account-teams.js";
import { unwrapRpcResult } from "../host/host-session-client.js";

/**
 * Where getting a person's agent into a team stands. An offline personal computer is
 * `pending-offline`, never `failed`: the coordinator retries with a fresh link code once it is
 * reachable. `no-agent` is a team entered with no agent here (no computer of the person's, or
 * disconnected); the intent still keeps the team on the device.
 */
export const TeamConnectionIntentStateSchema = z.enum([
  "connecting",
  "connected",
  "pending-offline",
  "failed",
  "no-agent",
]);
export type TeamConnectionIntentState = z.infer<typeof TeamConnectionIntentStateSchema>;

/**
 * Persisted per device so a restart resumes the connection and restores the team until Account's
 * directory lists it. Keyed by Account and team origin; the team Deployment id is null while a
 * hosted team is still being set up.
 */
export const TeamConnectionIntentSchema = z.strictObject({
  accountSubject: ControlPlaneAccountIdSchema,
  teamOrigin: TeamOriginSchema,
  teamDeploymentId: DeploymentIdSchema.nullable(),
  hostedTeamId: HostedTeamIdSchema.nullable(),
  /** Null for a person with no computer of their own: they chat, and no agent connects. */
  personalDeploymentId: DeploymentIdSchema.nullable(),
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
 * The device's team credentials: desktop main or mobile secure storage. The Account's identity
 * grant and the team's tokens are made and kept behind this port and never returned through it.
 */
export interface TeamSessionPort {
  verify(origin: string, signal?: AbortSignal): Promise<VerifiedTeam>;
  /**
   * Account signs who the person is for this exact team Host, and `POST /v1/team/session/exchange`
   * admits them (through `invite` when given); the tokens become the team's native credential.
   * Refusals throw `TeamEntryRefusedError`.
   */
  exchange(
    team: VerifiedTeam,
    invite: TeamInviteSecret | null,
    signal?: AbortSignal,
  ): Promise<TeamSessionEstablished>;
  /**
   * Keeps a team this device entered on it after a restart, until Account's directory lists it,
   * entering again when its credential is gone. Throws `TeamEntryRefusedError` once the team no
   * longer admits the person.
   */
  restore(team: {
    readonly origin: string;
    readonly teamDeploymentId: DeploymentId;
  }): Promise<void>;
  /**
   * The team's own browser sign-in, for a team without `team-session-exchange-v1` or an Account
   * that can't vouch yet. The browser proves `invite` first, so the team admits the person there.
   */
  signIn(team: VerifiedTeam, invite: TeamInviteSecret | null): Promise<TeamSessionEstablished>;
  /**
   * Opens the team's invite page in the system browser, for a team whose page can't continue to
   * this app's sign-in (no `team-invite-native-continuation-v1`): the person joins there.
   */
  joinInBrowser(team: VerifiedTeam, invite: TeamInviteSecret): Promise<void>;
  previewInvite(team: VerifiedTeam, invite: TeamInviteSecret): Promise<TeamInvitePreviewResponse>;
  /**
   * Revokes every agent link of the person's on the team, as the team itself lists them
   * (`revokeOwnAgentLinks`). The team stops honoring them at once, wherever they were made.
   */
  revokeAgentLinks(teamDeploymentId: DeploymentId): Promise<void>;
  /** `team.link.code.create` with the held session; answers the offer text. */
  createLinkCode(teamDeploymentId: DeploymentId): Promise<string>;
  /** `team.member.remove` of the session's own user; the team refuses its last owner. */
  leave(teamDeploymentId: DeploymentId): Promise<void>;
  /** Drops this device's credential and cached state for the team. */
  forget(teamDeploymentId: DeploymentId): Promise<void>;
}

/** `TeamSessionPort.revokeAgentLinks` over a team session's API. */
export async function revokeOwnAgentLinks(rpc: HostApiClient): Promise<void> {
  const me = unwrapRpcResult(await rpc["team.bootstrap.get"]({})).member.userId;
  const { links } = unwrapRpcResult(await rpc["team.links.list"]({}));
  for (const link of links)
    if (link.ownerUserId === me && link.state !== "revoked")
      unwrapRpcResult(
        await rpc["commands.dispatch"]({ type: "team.link.revoke", linkId: link.id }),
      );
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
  /** `no-agent` when no computer of the person's was chosen to connect. */
  readonly intent: TeamConnectionIntent;
}

/** What a coordinator is built from. */
export interface TeamCoordinatorPorts {
  readonly account: AccountTeamsClient;
  readonly sessions: TeamSessionPort;
  readonly personal: PersonalTeamLinksPort;
  readonly intents: TeamConnectionIntentStore;
  /** Who is signed in to Account; intents belong to that Account. */
  readonly accountSubject: () => ControlPlaneAccountId | null;
  /** Shows the team, landing in `TeamBootstrap.generalChannelId`. */
  readonly open: (teamDeploymentId: DeploymentId) => void;
}

export interface TeamCoordinatorSnapshot {
  /** Hosted teams this Account is still setting up, has failed to set up, or is deleting. */
  readonly hostedTeams: readonly HostedTeamView[];
  readonly intents: readonly TeamConnectionIntent[];
  /** The team whose setup is on screen; any other team that becomes ready is announced instead. */
  readonly watching: HostedTeamId | null;
  /** Teams that became ready while the person kept working, until they open or dismiss them. */
  readonly ready: readonly TeamReadyNotice[];
  /**
   * The origin of an older team the person is joining in their browser; the join waits for
   * `continueJoinInBrowser` (or `cancelJoinInBrowser`) before signing in to it here.
   */
  readonly joiningInBrowser: string | null;
}

export interface TeamReadyNotice {
  readonly hostedTeamId: HostedTeamId;
  readonly name: string;
  readonly teamDeploymentId: DeploymentId;
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
    readonly personalDeploymentId: DeploymentId | null;
  }): Promise<HostedTeamView>;
  retryHostedTeam(id: HostedTeamId): Promise<HostedTeamView>;
  /** The setup sheet closed: announce readiness instead of opening the team. */
  keepWorking(id: HostedTeamId): void;
  /** The setup sheet opened again for this team. */
  watch(id: HostedTeamId): void;
  dismissReady(id: HostedTeamId): void;
  /** Cancels setup or deletes the team, and forgets its intent. */
  deleteHostedTeam(id: HostedTeamId): Promise<void>;
  /** Who the team can be handed to: its other owners, as its Host confirms them now. */
  hostedTeamOwners(id: HostedTeamId, signal?: AbortSignal): Promise<readonly HostedTeamOwner[]>;
  /** Hands the team to one of them. The person stays an owner; nothing in the team changes. */
  transferHostedTeam(id: HostedTeamId, to: ControlPlaneAccountId): Promise<HostedTeamView>;
  /** What the join confirmation shows; consumes nothing. */
  previewInvite(inviteUrl: string): Promise<TeamInvitePreview>;
  joinWithInvite(input: {
    readonly inviteUrl: string;
    readonly personalDeploymentId: DeploymentId | null;
  }): Promise<TeamEntered>;
  /**
   * A session here on a team the person is already in, such as one Account lists from another
   * device: Account vouches where it can, else the team's own sign-in. Connects no agent.
   */
  enterTeam(origin: string): Promise<void>;
  /** The person is back from joining in their browser: sign in to the team here. */
  continueJoinInBrowser(): void;
  /** Stops a join waiting on the browser; that join rejects. */
  cancelJoinInBrowser(): void;
  connectAgent(input: {
    readonly teamDeploymentId: DeploymentId;
    readonly origin: string;
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

/** Polls of one outstanding hosted team, in ms; the last repeats. */
const setupBackoff = [1_000, 2_000, 3_000, 5_000, 8_000, 10_000] as const;
/** Fresh link codes for an offline personal computer, in ms; the last repeats. */
const offlineBackoff = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

function backoff(steps: readonly number[], attempt: number): number {
  return steps[Math.min(attempt, steps.length - 1)]!;
}

function message(error: unknown, fallback: string): string {
  const text = error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
  return text.slice(0, 500);
}

/** The origin and invite a pasted or opened invite link names, or null. */
export function readTeamInvite(
  inviteUrl: string,
): { readonly origin: string; readonly invite: TeamInviteSecret } | null {
  const page = parseTeamPageLink(inviteUrl.trim());
  if (page?.target.kind !== "invite") return null;
  return {
    origin: page.origin,
    invite: { selector: page.target.selector, verifier: page.target.verifier },
  };
}

export function createTeamCoordinator(ports: TeamCoordinatorPorts): TeamCoordinator {
  const listeners = new Set<() => void>();
  let snapshot: TeamCoordinatorSnapshot = {
    hostedTeams: [],
    intents: [],
    watching: null,
    ready: [],
    joiningInBrowser: null,
  };
  let disposed = false;
  /** Every intent of every Account this device has held; the snapshot shows the signed-in one's. */
  let stored: TeamConnectionIntent[] | null = null;
  const following = new Map<HostedTeamId, AbortController>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const connecting = new Map<string, Promise<TeamConnectionIntent>>();
  /**
   * Per team, advanced when the person disconnects, leaves or deletes it: an attempt or retry
   * begun under an older generation redeems nothing and records nothing.
   */
  const generations = new Map<string, number>();
  /** Teams whose agent is being disconnected; nothing connects them until that finishes. */
  const disconnecting = new Set<string>();

  /** The Account the snapshot shows; `resume` clears it when someone else signs in. */
  let heldFor = ports.accountSubject();
  /** Stops following setups and retrying connections; each was begun for one Account. */
  const settleAccountWork = () => {
    browserJoin?.settle(false);
    for (const controller of following.values()) controller.abort();
    following.clear();
    for (const [key, timer] of retries) {
      clearTimeout(timer);
      generations.set(key, generationOf(key) + 1);
    }
    retries.clear();
  };
  const publish = (next: Partial<TeamCoordinatorSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const subject = () => {
    const current = ports.accountSubject();
    if (current === null) throw new Error("Sign in to your Opensteer Account first.");
    return current;
  };
  const keyOf = (intent: TeamConnectionIntentKey) =>
    `${intent.accountSubject} ${intent.teamOrigin}`;
  const mine = () => {
    const current = ports.accountSubject();
    return (stored ?? []).filter((intent) => intent.accountSubject === current);
  };
  const load = async () => {
    stored ??= [...(await ports.intents.load())];
    return stored;
  };
  const save = async (intent: TeamConnectionIntent) => {
    const all = await load();
    const index = all.findIndex((held) => keyOf(held) === keyOf(intent));
    if (index === -1) all.push(intent);
    else all[index] = intent;
    await ports.intents.save(intent);
    publish({ intents: mine() });
    return intent;
  };
  const remove = async (key: TeamConnectionIntentKey) => {
    const all = await load();
    stored = all.filter((held) => keyOf(held) !== keyOf(key));
    invalidate(keyOf(key));
    await ports.intents.remove(key);
    publish({ intents: mine() });
  };
  const generationOf = (key: string) => generations.get(key) ?? 0;
  const invalidate = (key: string) => {
    generations.set(key, generationOf(key) + 1);
    clearTimeout(retries.get(key));
    retries.delete(key);
  };
  const intentFor = (match: (intent: TeamConnectionIntent) => boolean) =>
    mine().find(match) ?? null;
  const update = (view: HostedTeamView) => {
    const others = snapshot.hostedTeams.filter((team) => team.id !== view.id);
    publish({ hostedTeams: [...others, view] });
  };
  const drop = (id: HostedTeamId) => {
    following.get(id)?.abort();
    following.delete(id);
    publish({
      hostedTeams: snapshot.hostedTeams.filter((team) => team.id !== id),
      watching: snapshot.watching === id ? null : snapshot.watching,
    });
  };
  const intentBase = (
    origin: string,
    personalDeploymentId: DeploymentId | null,
    teamDeploymentId: DeploymentId | null,
    hostedTeamId: HostedTeamId | null,
  ): TeamConnectionIntent =>
    TeamConnectionIntentSchema.parse({
      accountSubject: subject(),
      teamOrigin: origin,
      teamDeploymentId,
      hostedTeamId,
      personalDeploymentId,
      state: personalDeploymentId === null ? "no-agent" : "connecting",
      failure: null,
      updatedAt: new Date().toISOString(),
    });

  let browserJoin: { readonly settle: (continued: boolean) => void } | null = null;
  /**
   * The team's own sign-in. A team whose invite page can't continue to it has the person join in
   * the browser first; they are a member by the time they come back to sign in here.
   */
  const signIn = async (
    team: VerifiedTeam,
    invite: TeamInviteSecret | null,
  ): Promise<TeamSessionEstablished> => {
    if (invite === null || team.capabilities.includes("team-invite-native-continuation-v1"))
      return ports.sessions.signIn(team, invite);
    browserJoin?.settle(false);
    let held!: { readonly settle: (continued: boolean) => void };
    const continued = new Promise<boolean>((settle) => (held = { settle }));
    browserJoin = held;
    publish({ joiningInBrowser: team.authority.canonicalOrigin });
    try {
      await ports.sessions.joinInBrowser(team, invite);
      if (!(await continued)) throw new Error("Joining was cancelled.");
    } finally {
      if (browserJoin === held) {
        browserJoin = null;
        publish({ joiningInBrowser: null });
      }
    }
    return { ...(await ports.sessions.signIn(team, null)), admitted: true };
  };

  /** A session on the team for the signed-in Account, admitting with `invite` when given. */
  const enter = async (
    origin: string,
    invite: TeamInviteSecret | null,
    signal?: AbortSignal,
  ): Promise<TeamSessionEstablished> => {
    const team = await ports.sessions.verify(origin, signal);
    if (!team.capabilities.includes("team-session-exchange-v1")) return signIn(team, invite);
    try {
      return await ports.sessions.exchange(team, invite, signal);
    } catch (error) {
      // Account can't vouch yet (an older replica), so the team's own sign-in, with the invite.
      if (!(error instanceof TeamIdentityGrantUnsupportedError)) throw error;
      return signIn(team, invite);
    }
  };

  const scheduleRetry = (intent: TeamConnectionIntent, attempt: number, generation: number) => {
    const key = keyOf(intent);
    clearTimeout(retries.get(key));
    if (disposed) return;
    retries.set(
      key,
      setTimeout(
        () => {
          retries.delete(key);
          const current = intentFor((held) => keyOf(held) === key);
          if (current?.state !== "pending-offline" || current.teamDeploymentId === null) return;
          void attemptConnect(current, attempt + 1, generation).catch(() => undefined);
        },
        backoff(offlineBackoff, attempt),
      ),
    );
  };

  /** One redemption at a time per team: a fresh code from the team, redeemed on the personal Host. */
  const attemptConnect = (
    intent: TeamConnectionIntent,
    attempt = 0,
    generation = generationOf(keyOf(intent)),
  ) => {
    const key = keyOf(intent);
    const held = connecting.get(key);
    if (held) return held;
    const current = () => !disposed && !disconnecting.has(key) && generationOf(key) === generation;
    const run = (async () => {
      const teamDeploymentId = intent.teamDeploymentId!;
      const personal = intent.personalDeploymentId;
      if (personal === null || !current()) return intent;
      await save({ ...intent, state: "connecting", failure: null, updatedAt: now() });
      let next: TeamConnectionIntent;
      try {
        const offer = await ports.sessions.createLinkCode(teamDeploymentId);
        // Disconnected meanwhile: the unredeemed code is revoked with the team's other links.
        if (!current()) return intent;
        const joined = await ports.personal.join(personal, offer);
        next = {
          ...intent,
          state: joined.kind === "joined" ? "connected" : "pending-offline",
          failure: null,
          updatedAt: now(),
        };
      } catch (error) {
        next = {
          ...intent,
          state: "failed",
          failure: message(error, "Your agent couldn’t connect."),
          updatedAt: now(),
        };
      }
      // Disconnected, left or deleted meanwhile: nothing to record.
      if (!current() || !intentFor((held) => keyOf(held) === key)) return next;
      await save(next);
      if (next.state === "pending-offline") scheduleRetry(next, attempt, generation);
      return next;
    })().finally(() => connecting.delete(key));
    connecting.set(key, run);
    return run;
  };

  /** A team entered with no agent to connect here, kept so a restart still restores it. */
  const keepWithoutAgent = async (origin: string, teamDeploymentId: DeploymentId) => {
    clearTimeout(retries.get(keyOf({ accountSubject: subject(), teamOrigin: origin })));
    const held = intentFor((intent) => intent.teamOrigin === origin);
    return save({
      ...(held ?? intentBase(origin, null, teamDeploymentId, null)),
      teamDeploymentId,
      personalDeploymentId: null,
      state: "no-agent",
      failure: null,
      updatedAt: now(),
    });
  };

  /** A team entered before a restart stays on the device; its agent picks up where it was. */
  const restoreThenConnect = async (
    intent: TeamConnectionIntent,
    teamDeploymentId: DeploymentId,
  ) => {
    const generation = generationOf(keyOf(intent));
    try {
      await ports.sessions.restore({ origin: intent.teamOrigin, teamDeploymentId });
    } catch (error) {
      // Removed meanwhile: nothing of this team is left to resume.
      if (
        error instanceof TeamEntryRefusedError &&
        teamEntryRefusalOutcome(error.reason) === "membership"
      )
        await remove(intent).catch(() => undefined);
      if (error instanceof TeamEntryRefusedError) return;
    }
    if (intent.state === "pending-offline" || intent.state === "connecting")
      await attemptConnect(intent, 0, generation).catch(() => undefined);
  };

  const settleReady = async (view: HostedTeamView, signal: AbortSignal) => {
    const intent = intentFor((held) => held.hostedTeamId === view.id);
    const established = await enter(view.origin, null, signal);
    const teamDeploymentId = established.team.authority.deploymentId;
    if (view.deploymentId && view.deploymentId !== teamDeploymentId)
      throw new Error("The team answered as a different Deployment.");
    if (signal.aborted) return;
    if (intent) await attemptConnect(await save({ ...intent, teamDeploymentId, updatedAt: now() }));
    if (signal.aborted) return;
    following.delete(view.id);
    const watched = snapshot.watching === view.id;
    publish({
      hostedTeams: snapshot.hostedTeams.filter((team) => team.id !== view.id),
      watching: watched ? null : snapshot.watching,
      ready: watched
        ? snapshot.ready
        : [
            ...snapshot.ready.filter((notice) => notice.hostedTeamId !== view.id),
            { hostedTeamId: view.id, name: view.name, teamDeploymentId },
          ],
    });
    if (watched) ports.open(teamDeploymentId);
  };

  /** Follows one hosted team to ready (then enters it), failure, or gone, polling with backoff. */
  const follow = (initial: HostedTeamView) => {
    if (following.has(initial.id) || disposed) return;
    const controller = new AbortController();
    following.set(initial.id, controller);
    const { signal } = controller;
    void (async () => {
      let view: HostedTeamView | null = initial;
      let attempt = 0;
      while (!signal.aborted) {
        if (view === null) {
          drop(initial.id);
          return;
        }
        update(view);
        if (view.stage === "failed") {
          following.delete(initial.id);
          return;
        }
        if (view.stage === "ready") {
          try {
            await settleReady(view, signal);
            return;
          } catch (error) {
            if (signal.aborted) return;
            // The team is ready but entering failed: show it as a failed setup to retry.
            update({
              ...view,
              stage: "failed",
              error: { message: message(error, "Setup didn’t finish.") },
            });
            following.delete(initial.id);
            return;
          }
        }
        await delay(backoff(setupBackoff, attempt++), signal).catch(() => undefined);
        if (signal.aborted) return;
        try {
          view = await ports.account.hostedTeam(initial.id, signal);
        } catch {
          // Account briefly out of reach: keep the last stage and keep following.
        }
      }
    })();
  };

  const coordinator: TeamCoordinator = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async createHostedTeam(input) {
      const origin = hostedTeamOrigin(input.slug);
      // Saved before Account answers, so a restart mid-create still connects the agent.
      await save(intentBase(origin, input.personalDeploymentId, null, null));
      let view: HostedTeamView;
      try {
        view = await ports.account.createHostedTeam({
          requestId: crypto.randomUUID(),
          name: input.name,
          slug: input.slug,
        });
      } catch (error) {
        await remove({ accountSubject: subject(), teamOrigin: origin });
        throw error;
      }
      const intent = intentFor((held) => held.teamOrigin === origin);
      if (intent) await save({ ...intent, teamOrigin: view.origin, hostedTeamId: view.id });
      publish({ watching: view.id });
      follow(view);
      return view;
    },

    async retryHostedTeam(id) {
      const view = await ports.account.retryHostedTeam(id);
      following.get(id)?.abort();
      following.delete(id);
      follow(view);
      return view;
    },

    keepWorking(id) {
      if (snapshot.watching === id) publish({ watching: null });
    },
    watch(id) {
      if (snapshot.hostedTeams.some((team) => team.id === id)) publish({ watching: id });
    },
    dismissReady(id) {
      publish({ ready: snapshot.ready.filter((notice) => notice.hostedTeamId !== id) });
    },

    async deleteHostedTeam(id) {
      const view = await ports.account.deleteHostedTeam(id);
      following.get(id)?.abort();
      following.delete(id);
      const intent = intentFor((held) => held.hostedTeamId === id);
      if (intent) {
        await remove(intent);
        if (intent.teamDeploymentId) {
          if (intent.personalDeploymentId)
            await ports.personal
              .leave(intent.personalDeploymentId, intent.teamDeploymentId)
              .catch(() => undefined);
          await ports.sessions.forget(intent.teamDeploymentId).catch(() => undefined);
        }
      }
      publish({ ready: snapshot.ready.filter((notice) => notice.hostedTeamId !== id) });
      if (view === null || view.stage !== "deleting") drop(id);
      else follow(view);
    },

    hostedTeamOwners(id, signal) {
      return ports.account.hostedTeamOwners(id, signal);
    },

    async transferHostedTeam(id, to) {
      const view = await ports.account.transferHostedTeam(id, to);
      if (snapshot.hostedTeams.some((team) => team.id === id)) update(view);
      return view;
    },

    async previewInvite(inviteUrl) {
      const read = readTeamInvite(inviteUrl);
      if (!read) throw new Error("That isn’t an invite link. Copy the whole link and try again.");
      const team = await ports.sessions.verify(read.origin);
      if (!team.capabilities.includes("team-reusable-invites-v1"))
        return { origin: read.origin, teamName: null };
      const preview = await ports.sessions.previewInvite(team, read.invite);
      return { origin: read.origin, teamName: preview.teamName };
    },

    async joinWithInvite(input) {
      const read = readTeamInvite(input.inviteUrl);
      if (!read) throw new Error("That isn’t an invite link. Copy the whole link and try again.");
      const established = await enter(read.origin, read.invite);
      const teamDeploymentId = established.team.authority.deploymentId;
      const origin = established.team.authority.canonicalOrigin;
      const intent =
        input.personalDeploymentId === null
          ? await keepWithoutAgent(origin, teamDeploymentId)
          : await coordinator.connectAgent({
              teamDeploymentId,
              origin,
              personalDeploymentId: input.personalDeploymentId,
            });
      ports.open(teamDeploymentId);
      return {
        teamDeploymentId,
        origin,
        member: established.member,
        admitted: established.admitted,
        intent,
      };
    },

    async enterTeam(origin) {
      await enter(origin, null);
    },

    continueJoinInBrowser() {
      browserJoin?.settle(true);
    },

    cancelJoinInBrowser() {
      browserJoin?.settle(false);
    },

    async connectAgent(input) {
      await load();
      const held = intentFor((intent) => intent.teamOrigin === input.origin);
      const intent = await save({
        ...(held ?? intentBase(input.origin, input.personalDeploymentId, null, null)),
        teamDeploymentId: input.teamDeploymentId,
        personalDeploymentId: input.personalDeploymentId,
        updatedAt: now(),
      });
      return attemptConnect(intent);
    },

    async disconnectAgent(teamDeploymentId) {
      await load();
      const held = intentFor((intent) => intent.teamDeploymentId === teamDeploymentId);
      const key = held ? keyOf(held) : null;
      if (key) {
        // Before revoking: a retry or attempt that finished after it would connect again.
        disconnecting.add(key);
        invalidate(key);
      }
      try {
        if (key) await connecting.get(key)?.catch(() => undefined);
        // Revoked by the team itself, so it holds with the computer off and for links made elsewhere.
        await ports.sessions.revokeAgentLinks(teamDeploymentId);
        const intent = intentFor((current) => current.teamDeploymentId === teamDeploymentId);
        if (!intent) return;
        // A computer that answers forgets the link now; one that's off, when the team refuses it.
        if (intent.personalDeploymentId)
          await ports.personal
            .leave(intent.personalDeploymentId, teamDeploymentId)
            .catch(() => undefined);
        await keepWithoutAgent(intent.teamOrigin, teamDeploymentId);
      } finally {
        if (key) disconnecting.delete(key);
      }
    },

    async leaveTeam(teamDeploymentId) {
      await load();
      await ports.sessions.leave(teamDeploymentId);
      const intent = intentFor((held) => held.teamDeploymentId === teamDeploymentId);
      if (intent) {
        await remove(intent);
        // A computer that is off keeps a link the team already refuses for a removed member.
        if (intent.personalDeploymentId)
          await ports.personal
            .leave(intent.personalDeploymentId, teamDeploymentId)
            .catch(() => undefined);
      }
      await ports.sessions.forget(teamDeploymentId);
    },

    async resume() {
      if (disposed) return;
      const current = ports.accountSubject();
      if (current !== heldFor) {
        // Another person may hold this device now: nothing of the last Account's stays on screen.
        heldFor = current;
        settleAccountWork();
        publish({
          hostedTeams: [],
          intents: mine(),
          watching: null,
          ready: [],
          joiningInBrowser: null,
        });
      }
      if (current === null) return;
      await load();
      publish({ intents: mine() });
      // Teams already entered come back whether or not Account can list hosted teams now.
      for (const intent of mine())
        if (intent.teamDeploymentId !== null)
          void restoreThenConnect(intent, intent.teamDeploymentId);
      const teams = await ports.account.listHostedTeams();
      // Signed out or switched meanwhile: that resume owns the snapshot now.
      if (disposed || ports.accountSubject() !== current) return;
      for (const intent of mine()) {
        if (intent.hostedTeamId !== null || intent.teamDeploymentId !== null) continue;
        // Saved before Account answered: the team it created at that address, or nothing.
        const created = teams.find((team) => team.origin === intent.teamOrigin);
        if (created) await save({ ...intent, hostedTeamId: created.id });
        else await remove(intent);
      }
      for (const team of teams) {
        const intent = intentFor((held) => held.hostedTeamId === team.id);
        // A ready team this device already entered needs nothing more.
        if (team.stage === "ready" && (intent === null || intent.teamDeploymentId !== null))
          continue;
        follow(team);
      }
    },

    dispose() {
      disposed = true;
      settleAccountWork();
      listeners.clear();
    },
  };
  return coordinator;
}

function now(): string {
  return new Date().toISOString();
}
