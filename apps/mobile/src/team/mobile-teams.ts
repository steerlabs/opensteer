import { TeamEntryRefusedError } from "@opensteer/client/auth";
import {
  HostVersionMismatchError,
  type DeploymentConnection,
  type PrivateFilesystem,
  type VerifiedHostEndpoint,
} from "@opensteer/client/connections";
import {
  HostClientRequestError,
  PersonalTeamLinks,
  unwrapRpcResult,
  type HostClient,
  type WebSocketClient,
} from "@opensteer/client/host";
import {
  listedTeams,
  NativeTeamEntry,
  TeamSavedStateSchema,
  TeamTransportRegistry,
  type TeamCacheScope,
  type TeamPersistence,
  type TeamSessionClient,
  type TeamSessionOptions,
} from "@opensteer/client/team";
import {
  DeploymentIdSchema,
  parseTeamPageLink,
  type DeploymentId,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  UserIdSchema,
  type TeamInviteSecret,
  type TeamPageLink,
} from "@opensteer/core";
import { parseTeamLinkOffer, type HostApiClient, type TeamMember } from "@opensteer/protocol";
import { z } from "zod";
import type { MobileClient, MobileTeamConnection } from "../client/mobile-client.js";
import type { NotificationPreviews } from "../notifications/notification-preview.js";

/**
 * Everything one team Host is reached through: typed calls, its socket and its
 * file routes. A real team is a pinned transport to its own origin; mock mode
 * answers from memory. Neither ever carries the personal Deployment's
 * credential.
 */
export interface TeamTransport {
  readonly rpc: HostApiClient;
  readonly connect: () => WebSocketClient;
  readonly readFile: NonNullable<TeamSessionOptions["readFile"]>;
  readonly uploadFile: NonNullable<TeamSessionOptions["uploadFile"]>;
}

/** How a team stands on this phone, as the drawer and a team screen say it. */
export type TeamState =
  | "signed-out"
  | "loading"
  | "live"
  | "offline"
  | "update-app"
  | "update-server"
  | "removed"
  | "join";

export interface MobileTeam {
  readonly teamId: string;
  /** This phone holds the team's Host and can sign in to it; otherwise only its computer knows it. */
  readonly onPhone: boolean;
  /** The team's own name once its Host has said it; until then its address. */
  readonly name: string;
  readonly origin: string;
  readonly state: TeamState;
  readonly detail: string | null;
  /** Present once this phone knows who it is on the team. */
  readonly session: TeamSessionClient | null;
  readonly userId: string | null;
}

export interface MobileTeamsSnapshot {
  /** The computer the phone is showing; its agent links add to the teams listed. */
  readonly computerId: string | null;
  /** The teams Account lists the person in, then any the computer being shown is linked to. */
  readonly teams: readonly MobileTeam[];
  /** Teams this phone holds that neither Account nor a known computer of the reader's lists. */
  readonly unlinked: readonly MobileTeam[];
  /** The one team this phone keeps a socket to. */
  readonly selected: string | null;
}

/** What a team page link, a pasted link or a team notification asks for. */
export type TeamLinkIntent =
  | {
      readonly kind: "invite";
      readonly origin: string;
      readonly selector: string;
      readonly verifier: string;
    }
  | {
      readonly kind: "open";
      readonly origin: string;
      readonly channelId: string;
      readonly messageId: string | null;
    }
  /** A one-time code from a team's web page, carried to the person's own Opensteer. */
  | { readonly kind: "agent-link"; readonly origin: string; readonly text: string };

/** Reads what a person pasted, or a link an app handoff carried. Never an authority. */
export function readTeamLinkIntent(text: string): TeamLinkIntent | null {
  const trimmed = text.trim();
  const offer = parseTeamLinkOffer(trimmed);
  if (offer !== null) return { kind: "agent-link", origin: offer.origin, text: trimmed };
  const page = parseTeamPageLink(trimmed);
  return page === null ? null : intentOf(page);
}

export function intentOf(page: TeamPageLink): TeamLinkIntent {
  switch (page.target.kind) {
    case "invite":
      return {
        kind: "invite",
        origin: page.origin,
        selector: page.target.selector,
        verifier: page.target.verifier,
      };
    case "channel":
      return {
        kind: "open",
        origin: page.origin,
        channelId: page.target.channelId,
        messageId: null,
      };
    case "message":
      return {
        kind: "open",
        origin: page.origin,
        channelId: page.target.channelId,
        messageId: page.target.messageId,
      };
  }
}

/** Where a message link lands once the team has said the reader may see it. */
export type TeamDestination =
  | { readonly kind: "channel"; readonly channelId: string; readonly messageId: string | null }
  | {
      readonly kind: "thread";
      readonly channelId: string;
      readonly rootId: string;
      readonly replyId: string | null;
    };

export class TeamAccessError extends Error {
  override readonly name = "TeamAccessError";
}

const LinkedTeamSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  origin: z.string().min(1).max(2_048),
  teamName: z.string().min(1).max(160),
});
export type LinkedTeam = z.infer<typeof LinkedTeamSchema>;

/**
 * What this phone remembers about teams beside their credentials: who the
 * reader is on each, and which teams each of their computers is in — learnt
 * from that computer while it answers, so team chat still works when the
 * laptop is off.
 */
const TeamMemoSchema = z.strictObject({
  schemaVersion: z.literal(1),
  users: z.record(z.string(), UserIdSchema),
  computers: z.record(z.string(), z.array(LinkedTeamSchema).max(100)),
});

/**
 * The person's teams on this phone.
 *
 * A team is its own Host in the catalog, beside — never instead of — the
 * selected personal Opensteer. Per Fable's ruling the phone keeps a socket only
 * to the team in view and relies on push for the rest; a team out of view
 * still paints its drawer section from its last answer.
 */
export class MobileTeams {
  readonly registry: TeamTransportRegistry;
  readonly #client: MobileClient;
  readonly #transport: (connection: DeploymentConnection, scope: TeamCacheScope) => TeamTransport;
  readonly #verify: (origin: string) => Promise<VerifiedHostEndpoint>;
  readonly #entry: NativeTeamEntry;
  readonly #usersFile: string;
  readonly #seed: Readonly<Record<string, readonly LinkedTeam[]>>;
  readonly #files: PrivateFilesystem;
  readonly #previews: NotificationPreviews | null;
  readonly #listeners = new Set<() => void>();
  readonly #sessions = new Map<string, TeamSessionClient>();
  readonly #states = new Map<string, { state: TeamState; detail: string | null }>();
  readonly #names = new Map<string, string>();
  readonly #members = new Map<string, Promise<readonly TeamMember[]>>();
  readonly #detachSessions = new Map<string, () => void>();
  #memo: z.infer<typeof TeamMemoSchema> | null = null;
  #selected: string | null = null;
  /** Bumped by every selection, backgrounding and disposal; a slower, older one never wins. */
  #selection = 0;
  /** The team last opened on each computer: the one kept connected while its drawer shows. */
  readonly #recent = new Map<string, string>();
  #foreground = true;
  #linksFor: HostClient | null = null;
  #snapshot: MobileTeamsSnapshot = { computerId: null, teams: [], unlinked: [], selected: null };
  #detachClient: (() => void) | null = null;

  constructor(options: {
    readonly client: MobileClient;
    readonly transport: (connection: DeploymentConnection, scope: TeamCacheScope) => TeamTransport;
    readonly verify: (origin: string) => Promise<VerifiedHostEndpoint>;
    readonly files: PrivateFilesystem;
    readonly directory: string;
    /** Where each signed-in team's notification preview key is registered. */
    readonly previews?: NotificationPreviews | null;
    /** Mock mode's computers and the teams each is in, before any computer has said. */
    readonly seed?: Readonly<Record<string, readonly LinkedTeam[]>>;
  }) {
    this.#seed = options.seed ?? {};
    this.#client = options.client;
    this.#transport = options.transport;
    this.#verify = options.verify;
    this.#entry = new NativeTeamEntry({
      oauth: options.client.oauth,
      catalog: options.client.catalog,
    });
    this.#files = options.files;
    this.#previews = options.previews ?? null;
    this.#usersFile = `${options.directory}/teams.json`;
    const persistence = teamFilePersistence(options.files, `${options.directory}/teams`);
    this.registry = new TeamTransportRegistry("mobile", (scope) => {
      const connection = this.#connection(scope.teamDeploymentId);
      if (connection === null) throw new TeamAccessError("This team is no longer on this phone.");
      const transport = this.#transport(connection, scope);
      return {
        scope,
        rpc: transport.rpc,
        persistence,
        connect: transport.connect,
        readFile: transport.readFile,
        uploadFile: transport.uploadFile,
      };
    });
  }

  start(): void {
    if (this.#detachClient !== null) return;
    this.#detachClient = this.#client.subscribe(() => {
      const shown = this.#snapshot.computerId;
      // Signed out of a team, here or by its own screen: its session and partition go.
      for (const teamId of this.#sessions.keys())
        if (!this.#signedIn(teamId)) void this.#signedOut(teamId);
      this.#publish();
      // Another computer on screen: its team takes the one socket.
      if (this.#snapshot.computerId !== shown) void this.select(this.#selected);
      this.#learnLinks();
    });
    void this.#loadMemo().then(() => {
      this.#publish();
      this.#learnLinks();
      void this.select(this.#selected);
    });
  }

  /** The app went to the background or came back: no socket while nobody looks. */
  foreground(active: boolean): void {
    this.#foreground = active;
    void this.select(this.#selected);
  }

  /**
   * Which teams the computer being shown is in, asked of that computer while
   * it answers and remembered for when it doesn't.
   */
  #learnLinks(): void {
    const { selection } = this.#client.getSnapshot();
    const personal = selection.hostClient;
    if (personal === null || personal === this.#linksFor || selection.deploymentId === null) return;
    this.#linksFor = personal;
    const computerId = selection.deploymentId;
    void new PersonalTeamLinks(personal.rpc).list().then(
      async (links) => {
        await this.#loadMemo();
        const linked = links
          .filter((link) => link.state !== "revoked" && link.state !== "leaving")
          .map((link) => ({ teamId: link.teamId, origin: link.origin, teamName: link.teamName }));
        this.#memo = {
          ...this.#memo!,
          computers: { ...this.#memo!.computers, [computerId]: linked },
        };
        await this.#saveMemo();
        this.#publish();
        void this.select(this.#selected);
      },
      () => undefined,
    );
  }

  /** Records that a computer joined a team from this phone. */
  async #remember(computerId: string, team: LinkedTeam): Promise<void> {
    await this.#loadMemo();
    const held = this.#memo!.computers[computerId] ?? [];
    this.#memo = {
      ...this.#memo!,
      computers: {
        ...this.#memo!.computers,
        [computerId]: [...held.filter((row) => row.teamId !== team.teamId), team],
      },
    };
    await this.#saveMemo();
    this.#publish();
  }

  dispose(): void {
    this.#selection++;
    this.#detachClient?.();
    this.#detachClient = null;
    for (const detach of this.#detachSessions.values()) detach();
    this.#detachSessions.clear();
    this.registry.dispose();
  }

  readonly getSnapshot = (): MobileTeamsSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  team(teamId: string): MobileTeam | null {
    return (
      [...this.#snapshot.teams, ...this.#snapshot.unlinked].find(
        (team) => team.teamId === teamId,
      ) ?? null
    );
  }

  /** The team whose origin a link names, if this phone holds it. */
  teamAt(origin: string): MobileTeam | null {
    return (
      [...this.#snapshot.teams, ...this.#snapshot.unlinked].find(
        (team) => team.origin === origin,
      ) ?? null
    );
  }

  /**
   * The teams a computer of the reader's is in, as this phone last learnt, each
   * with the session this phone holds for it (for its badge) if any.
   */
  teamsOn(
    computerId: string,
  ): readonly { readonly team: LinkedTeam; readonly session: TeamSessionClient | null }[] {
    return (this.#memo?.computers[computerId] ?? []).map((team) => ({
      team: { ...team, teamName: this.#names.get(team.teamId) ?? team.teamName },
      session: this.#sessions.get(team.teamId) ?? null,
    }));
  }

  /** The computers of the reader's this phone knows to be in a team. */
  computersIn(teamId: string): readonly string[] {
    return Object.entries(this.#memo?.computers ?? {})
      .filter(([, teams]) => teams.some((team) => team.teamId === teamId))
      .map(([computerId]) => computerId);
  }

  /**
   * A team the computer being shown is in, but whose Host this phone has not
   * reached yet: it is added and the person signs in to it, as on any device.
   */
  async addToPhone(teamId: string, interactive = true): Promise<void> {
    const team = this.team(teamId);
    if (team === null) throw new TeamAccessError("This team is no longer on this computer.");
    if (this.#signedIn(teamId)) return;
    try {
      const verified = await this.#verify(team.origin);
      if (verified.discovery.deploymentId !== teamId)
        throw new Error("That address now answers as a different team.");
      await this.#entry.ensureAuthorized(verified, null, interactive);
      this.#states.delete(teamId);
      this.#publish();
    } catch (error) {
      this.#fail(teamId, error);
      throw error;
    }
  }

  /**
   * The session for one team, made the first time it is needed. Learning who the
   * reader is costs one bootstrap the first time a team is seen on this phone;
   * after that the answer is remembered beside the session's own cache.
   */
  async session(teamId: string): Promise<TeamSessionClient> {
    const held = this.#sessions.get(teamId);
    if (held !== undefined && held.getSnapshot().ended === null) return held;
    if (held !== undefined) this.#ended(teamId, held);
    const connection = this.#connection(teamId);
    if (connection === null) throw new TeamAccessError("This team is no longer on this phone.");
    await this.#loadMemo();
    let userId = this.#memo?.users[teamId] ?? null;
    if (userId === null) {
      this.#setState(teamId, "loading", null);
      try {
        const bootstrap = unwrapRpcResult(
          await this.#transport(connection, {
            teamDeploymentId: teamId,
            userId: placeholderUser,
          }).rpc["team.bootstrap.get"]({}),
        );
        userId = bootstrap.member.userId;
        this.#names.set(teamId, bootstrap.teamName);
        await this.#rememberUser(teamId, userId);
      } catch (error) {
        this.#fail(teamId, error);
        throw error;
      }
    }
    const scope = { teamDeploymentId: teamId, userId };
    const session = await this.registry.join(scope);
    if (!this.#sessions.has(teamId)) {
      this.#sessions.set(teamId, session);
      this.#detachSessions.set(
        teamId,
        // Only a name change or the session ending reaches the team list; rows
        // and badges read the session themselves, so a typing frame redraws nothing else.
        session.subscribe(() => {
          if (session.getSnapshot().ended !== null) {
            this.#ended(teamId, session);
            return;
          }
          const name = session.getSnapshot().bootstrap?.teamName;
          if (name === undefined || this.#names.get(teamId) === name) return;
          this.#names.set(teamId, name);
          this.#publish();
        }),
      );
      // The team seals a push preview only for a key this phone registered with it.
      this.#previews?.attach({
        deploymentId: DeploymentIdSchema.parse(teamId),
        capabilities: connection.capabilities ?? [],
        current: () => this.#sessions.get(teamId) === session && this.#signedIn(teamId),
        dispatch: ({ type: _type, ...input }) => session.registerNotificationPreview(input),
      });
    }
    this.#publish();
    return this.#sessions.get(teamId) ?? session;
  }

  /**
   * The one team this phone keeps a socket to: the team on screen, or else the
   * team of the computer being shown that was opened last, so its row's badge
   * stays current. None while the app is in the background.
   */
  async select(teamId: string | null): Promise<void> {
    const generation = ++this.#selection;
    const { computerId } = this.#snapshot;
    if (teamId !== null && computerId !== null) this.#recent.set(computerId, teamId);
    const target = this.#foreground ? (teamId ?? this.#ambient()) : null;
    this.#selected = teamId;
    if (target === null) {
      await this.registry.select(null);
      return;
    }
    const current = () => generation === this.#selection;
    try {
      if (!this.#signedIn(target)) await this.addToPhone(target, false);
      if (!this.#signedIn(target) || !current()) return;
      const session = await this.session(target);
      const userId = this.#memo?.users[target];
      if (userId === undefined || !current()) return;
      await this.registry.select({ teamDeploymentId: target, userId });
      if (current() && session.getSnapshot().bootstrap !== null)
        this.#setState(target, "live", null);
    } catch (error) {
      if (current()) this.#fail(target, error);
    }
  }

  #ambient(): string | null {
    const { computerId, teams } = this.#snapshot;
    const ready = teams.filter((team) => team.onPhone && team.state !== "signed-out");
    const recent = computerId === null ? undefined : this.#recent.get(computerId);
    return (ready.find((team) => team.teamId === recent) ?? ready[0])?.teamId ?? null;
  }

  /** Paints a drawer section for a team out of view: one bootstrap, no socket. */
  async refresh(teamId: string): Promise<void> {
    try {
      const session = await this.session(teamId);
      if (session.getSnapshot().bootstrap === null) await session.load(false);
      else await session.refreshSidebar();
      this.#setState(teamId, "live", null);
    } catch (error) {
      this.#fail(teamId, error);
    }
  }

  /** The team's people, read once per session: names, handles and faces for its screens. */
  members(teamId: string): Promise<readonly TeamMember[]> {
    const held = this.#members.get(teamId);
    if (held !== undefined) return held;
    const loading = (async () => {
      const session = await this.session(teamId);
      const people: TeamMember[] = [];
      let after: string | undefined;
      // A thousand people is the most a phone lists; past that a team is read by search.
      for (let page = 0; page < 20; page++) {
        const result = unwrapRpcResult(
          await session.rpc["team.members.list"](
            after === undefined ? {} : { after: UserIdSchema.parse(after) },
          ),
        );
        people.push(...result.members);
        if (!result.hasMore || result.members.length === 0) break;
        after = result.members.at(-1)!.userId;
      }
      return people;
    })();
    this.#members.set(teamId, loading);
    loading.catch(() => this.#members.delete(teamId));
    return loading;
  }

  forgetMembers(teamId: string): void {
    this.#members.delete(teamId);
  }

  /**
   * Where a message link may land, asked of the team as the reader: a removed
   * member, a deleted message or a channel they cannot read goes nowhere, even
   * from a notification sent before the change.
   */
  async destination(
    teamId: string,
    channelId: string,
    messageId: string | null,
  ): Promise<TeamDestination> {
    const session = await this.session(teamId);
    const channel = TeamChannelIdSchema.parse(channelId);
    if (messageId === null) {
      unwrapRpcResult(await session.rpc["team.channel.get"]({ channelId: channel }));
      return { kind: "channel", channelId, messageId: null };
    }
    const message = unwrapRpcResult(
      await session.rpc["team.message.get"]({
        channelId: channel,
        messageId: TeamMessageIdSchema.parse(messageId),
      }),
    );
    return message.threadRootId === null
      ? { kind: "channel", channelId, messageId: message.id }
      : { kind: "thread", channelId, rootId: message.threadRootId, replyId: message.id };
  }

  /**
   * A team Host at a link's origin: the one already held, or a verified new
   * entry the person has not joined yet. Verifying sends no credential.
   */
  async locate(
    origin: string,
  ): Promise<
    | { readonly kind: "held"; readonly team: MobileTeam }
    | { readonly kind: "new"; readonly verified: VerifiedHostEndpoint }
  > {
    const held = this.teamAt(origin);
    if (held !== null) return { kind: "held", team: held };
    return { kind: "new", verified: await this.verifyTeam(origin) };
  }

  /** A team Host at an origin, verified through its signed discovery. Sends no credential. */
  async verifyTeam(origin: string): Promise<VerifiedHostEndpoint> {
    const verified = await this.#verify(origin);
    if (verified.discovery.deploymentShape.kind !== "team")
      throw new Error(
        "That link isn't for a team. Ask whoever sent it for the team's invite link.",
      );
    return verified;
  }

  /**
   * Entering a team whose server predates native team sessions, or whose Account can't vouch
   * yet: the team enters this phone's catalog and the person signs in to it in the browser,
   * through the invite when given so the team admits them there. Connecting their agent is the
   * coordinator's next step, not this one's.
   */
  async signIn(
    verified: VerifiedHostEndpoint,
    invite: TeamInviteSecret | null,
  ): Promise<TeamMember> {
    const teamId = verified.discovery.deploymentId;
    await this.#entry.ensureAuthorized(verified, invite);
    const connection = (await this.#client.catalog.load()).deployments.find(
      ({ authority }) => authority.document.deploymentId === teamId,
    );
    if (!connection) throw new TeamAccessError("This team is no longer on this phone.");
    return (await this.#settle(connection)).member;
  }

  /**
   * Entering a team as the signed-in Account, without a browser: the team joins this phone's
   * catalog as an Account entry, its tokens stay in this phone's secure storage, and an invite,
   * when given, admits the person. Connecting their agent is the coordinator's next step.
   */
  async enter(
    verified: VerifiedHostEndpoint,
    invite: TeamInviteSecret | null,
  ): Promise<{ readonly admitted: boolean; readonly member: TeamMember }> {
    const entered = await this.#entry.enter(verified, invite);
    const teamId = verified.discovery.deploymentId;
    const connection = (await this.#client.catalog.load()).deployments.find(
      ({ authority }) => authority.document.deploymentId === teamId,
    );
    // Opening the team learns the same once the phone shows it; this only saves that wait.
    if (connection !== undefined) await this.#settle(connection).catch(() => undefined);
    return entered;
  }

  /** A team entered before a restart stays on this phone until Account's directory lists it. */
  async restore(origin: string, teamId: DeploymentId): Promise<void> {
    await this.#entry.restore(teamId, () => this.verifyTeam(origin));
  }

  /** Learns the team's name and who the reader is, and shows it on the computer being shown. */
  async #settle(connection: DeploymentConnection) {
    const teamId = connection.authority.document.deploymentId;
    const transport = this.#transport(connection, {
      teamDeploymentId: teamId,
      userId: placeholderUser,
    });
    const bootstrap = unwrapRpcResult(await transport.rpc["team.bootstrap.get"]({}));
    this.#names.set(teamId, bootstrap.teamName);
    await this.#rememberUser(teamId, bootstrap.member.userId);
    await this.adopt({
      teamId,
      origin: connection.authority.document.canonicalOrigin,
      teamName: bootstrap.teamName,
    });
    return bootstrap;
  }

  /**
   * A team this phone now holds a session for joins the drawer of the computer
   * being shown: that computer runs the agent the team asks.
   */
  async adopt(team: LinkedTeam): Promise<void> {
    const computerId = this.#client.getSnapshot().selection.deploymentId;
    if (computerId === null) {
      this.#publish();
      return;
    }
    await this.#remember(computerId, team);
  }

  /** A code the team's web page showed, carried to the reader's own Opensteer. */
  async redeem(text: string, personal: HostClient): Promise<string> {
    const link = await new PersonalTeamLinks(personal.rpc).join(text);
    return link.teamName;
  }

  /**
   * Leaving: the team removes the reader's membership first — it alone decides,
   * and refuses the last owner — then the link from the reader's Opensteer is
   * cut and everything this phone kept for the team (drafts, unsent messages,
   * its preview key, credential and catalog entry) is removed.
   */
  async leave(teamId: string): Promise<void> {
    await (await this.session(teamId)).leave();
    const personal = this.#client.getSnapshot().selection.hostClient;
    // A computer that is off keeps a link the team already refuses for a removed member.
    if (personal !== null)
      await new PersonalTeamLinks(personal.rpc).leave(teamId).catch(() => undefined);
    await this.forget(teamId);
  }

  /** Removes a team from this phone without asking it anything (after removal). */
  async forget(teamId: string): Promise<void> {
    const userId = this.#memo?.users[teamId];
    if (userId !== undefined) await this.registry.remove({ teamDeploymentId: teamId, userId });
    this.#drop(teamId);
    this.#states.delete(teamId);
    if (this.#memo !== null) {
      const { [teamId]: _forgotten, ...users } = this.#memo.users;
      this.#memo = {
        ...this.#memo,
        users,
        computers: Object.fromEntries(
          Object.entries(this.#memo.computers).map(([computer, teams]) => [
            computer,
            teams.filter((team) => team.teamId !== teamId),
          ]),
        ),
      };
      await this.#saveMemo();
    }
    const connection = this.#connection(teamId);
    if (connection !== null) {
      await this.#client.signOut(teamId).catch(() => undefined);
      // An entry this phone added itself; one Account's directory lists comes back with it.
      if (connection.source.kind === "manual" || connection.accountAccess === null)
        await this.#client.remove(teamId);
    }
    this.#publish();
  }

  /**
   * The team ended this reader's session: they were removed, must sign in
   * again, or the team's login now names someone else. The session has already
   * purged its own partition; this phone stops holding it and says why.
   */
  #ended(teamId: string, session: TeamSessionClient): void {
    if (this.#sessions.get(teamId) !== session) return;
    const ended = session.getSnapshot().ended;
    this.#drop(teamId);
    void this.#previews?.clear(DeploymentIdSchema.parse(teamId));
    if (ended === "viewer-changed") {
      // Who the reader is gets learnt again, under the new login.
      void this.#forgetUser(teamId).then(() => this.select(this.#selected));
      return;
    }
    this.#setState(teamId, ended === "removed" ? "removed" : "signed-out", null);
  }

  /** Signed out of the team on this phone: its drafts and unsent messages go with it. */
  async #signedOut(teamId: string): Promise<void> {
    const userId = this.#memo?.users[teamId];
    this.#drop(teamId);
    if (userId !== undefined) await this.registry.remove({ teamDeploymentId: teamId, userId });
    this.#publish();
  }

  #drop(teamId: string): void {
    this.#detachSessions.get(teamId)?.();
    this.#detachSessions.delete(teamId);
    this.#sessions.delete(teamId);
    this.#members.delete(teamId);
  }

  async #forgetUser(teamId: string): Promise<void> {
    if (this.#memo === null || this.#memo.users[teamId] === undefined) return;
    const { [teamId]: _forgotten, ...users } = this.#memo.users;
    this.#memo = { ...this.#memo, users };
    await this.#saveMemo();
  }

  #connection(teamId: string): DeploymentConnection | null {
    return (
      this.#client
        .getSnapshot()
        .teams.find(({ connection }) => connection.authority.document.deploymentId === teamId)
        ?.connection ?? null
    );
  }

  #signedIn(teamId: string): boolean {
    return this.#client
      .getSnapshot()
      .teams.some(
        ({ connection, signedIn }) =>
          signedIn && connection.authority.document.deploymentId === teamId,
      );
  }

  #setState(teamId: string, state: TeamState, detail: string | null): void {
    const held = this.#states.get(teamId);
    if (held?.state === state && held.detail === detail) return;
    this.#states.set(teamId, { state, detail });
    this.#publish();
  }

  #fail(teamId: string, error: unknown): void {
    this.#setState(teamId, teamFailure(error), error instanceof Error ? error.message : null);
  }

  async #loadMemo(): Promise<void> {
    if (this.#memo !== null) return;
    const stored = await this.#files.readFile(this.#usersFile, 256 * 1024).catch(() => null);
    let memo: z.infer<typeof TeamMemoSchema> = {
      schemaVersion: 1,
      users: {},
      computers: Object.fromEntries(
        Object.entries(this.#seed).map(([computer, teams]) => [computer, [...teams]]),
      ),
    };
    if (stored !== null) {
      try {
        const parsed = TeamMemoSchema.safeParse(JSON.parse(new TextDecoder().decode(stored)));
        if (parsed.success) memo = parsed.data;
      } catch {
        // An unreadable file costs one bootstrap per team, never a team.
      }
    }
    this.#memo ??= memo;
  }

  async #rememberUser(teamId: string, userId: string): Promise<void> {
    await this.#loadMemo();
    const previous = this.#memo!.users[teamId];
    if (previous === userId) return;
    // Another person on the same team: the old partition goes before the new one is used.
    if (previous !== undefined)
      await this.registry.remove({ teamDeploymentId: teamId, userId: previous });
    this.#memo = {
      ...this.#memo!,
      users: { ...this.#memo!.users, [teamId]: UserIdSchema.parse(userId) },
    };
    await this.#saveMemo();
  }

  async #saveMemo(): Promise<void> {
    await this.#files.writeFileAtomic(
      this.#usersFile,
      JSON.stringify(TeamMemoSchema.parse(this.#memo)),
    );
  }

  #publish(): void {
    const state = this.#client.getSnapshot();
    const computerId = state.selection.deploymentId;
    const catalog = new Map(
      state.teams.map((entry) => [entry.connection.authority.document.deploymentId, entry]),
    );
    const computers = this.#memo?.computers ?? {};
    const listed = listedTeams({
      account: state.teams
        .filter(({ connection }) => connection.accountAccess !== null)
        .map(({ connection }) => ({
          teamDeploymentId: connection.authority.document.deploymentId,
          origin: connection.authority.document.canonicalOrigin,
          name: connection.name,
        })),
      links: computerId === null ? [] : (computers[computerId] ?? []),
      intents: [],
    });
    const known = new Set([
      ...listed.map((team) => team.teamDeploymentId),
      ...Object.values(computers).flatMap((teams) => teams.map((t) => t.teamId)),
    ]);
    this.#snapshot = {
      computerId,
      teams: listed.map((team) => {
        const teamId = DeploymentIdSchema.parse(team.teamDeploymentId);
        return this.#describe(
          { teamId, origin: team.origin, teamName: team.name },
          catalog.get(teamId) ?? null,
        );
      }),
      unlinked: state.teams
        .filter((entry) => !known.has(entry.connection.authority.document.deploymentId))
        .map((entry) =>
          this.#describe(
            {
              teamId: entry.connection.authority.document.deploymentId,
              origin: entry.connection.authority.document.canonicalOrigin,
              teamName: entry.connection.name,
            },
            entry,
          ),
        ),
      selected: this.#selected,
    };
    for (const listener of this.#listeners) listener();
  }

  #describe(team: LinkedTeam, entry: MobileTeamConnection | null): MobileTeam {
    const held = this.#states.get(team.teamId);
    const session = this.#sessions.get(team.teamId) ?? null;
    const state: TeamState =
      held?.state ??
      (entry === null || !entry.signedIn
        ? "signed-out"
        : session?.getSnapshot().bootstrap
          ? "live"
          : "loading");
    return {
      teamId: team.teamId,
      onPhone: entry !== null,
      name: this.#names.get(team.teamId) ?? team.teamName,
      origin: team.origin,
      state,
      detail: held?.detail ?? null,
      session,
      userId: this.#memo?.users[team.teamId] ?? null,
    };
  }
}

/**
 * Who the reader is on a team is not known before the first answer, and a
 * pinned transport validates its partition key, so the first bootstrap is asked
 * under a placeholder that names nobody and keys no cache.
 */
const placeholderUser = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000000");

/** What a failed team call says about the team, for the drawer and its banner. */
export function teamFailure(error: unknown): TeamState {
  if (error instanceof TeamEntryRefusedError && error.reason === "not-a-member") return "join";
  if (error instanceof HostVersionMismatchError)
    return error.code === "client-too-old" ? "update-app" : "update-server";
  if (error instanceof HostClientRequestError) {
    if (error.code === "unauthorized") return "signed-out";
    if (error.code === "forbidden" || error.code === "not_found") return "removed";
    if (error.code === "version_mismatch" || error.code === "upgrade_required") return "update-app";
  }
  if (error instanceof TeamAccessError) return "removed";
  return "offline";
}

/**
 * Drafts and unsent messages for one person on one team, beside — never
 * inside — the protected credential. One file per partition, so removing a
 * team or a person removes exactly theirs.
 */
export function teamFilePersistence(files: PrivateFilesystem, directory: string): TeamPersistence {
  const path = (scope: TeamCacheScope): string =>
    `${directory}/${DeploymentIdSchema.parse(scope.teamDeploymentId)}.${UserIdSchema.parse(scope.userId)}.json`;
  return {
    async load(scope) {
      const stored = await files.readFile(path(scope), 4 * 1024 * 1024);
      if (stored === null) return null;
      try {
        const parsed = TeamSavedStateSchema.safeParse(JSON.parse(new TextDecoder().decode(stored)));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async save(scope, state) {
      await files.ensureDirectory(directory);
      await files.writeFileAtomic(path(scope), JSON.stringify(TeamSavedStateSchema.parse(state)));
    },
    async remove(scope) {
      await files.removeFile(path(scope));
    },
  };
}
