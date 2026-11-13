import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import type { HostedTeamSlug } from "@opensteer/control-plane-protocol/hosted-teams";
import { TeamEntryRefusedError, TeamIdentityGrantUnsupportedError } from "../auth/native-oauth.js";
import { MockTeamWorld } from "./mock-hosted-teams.js";
import { MockTeamHost } from "./mock-team-host.js";
import { createTeamCoordinator, readTeamInvite, type TeamCoordinator } from "./team-coordinator.js";

const personal = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000cc");

function start(world = new MockTeamWorld()) {
  const opened: DeploymentId[] = [];
  const coordinator = createTeamCoordinator({
    account: world.account,
    sessions: world.sessions,
    personal: world.personal,
    intents: world.intents,
    accountSubject: world.accountSubject,
    open: (id) => opened.push(id),
  });
  return { world, coordinator, opened };
}

/** Runs timers until `done` holds; every hosted setup finishes inside a few seconds of mock time. */
async function until(done: () => boolean, what: string) {
  for (let step = 0; step < 200 && !done(); step++) await vi.advanceTimersByTimeAsync(250);
  if (!done()) throw new Error(`Never happened: ${what}`);
}

/** The links a team still honors, as the team Host itself lists them. */
async function activeLinks(world: MockTeamWorld, teamDeploymentId: DeploymentId) {
  const host = world.joined().find((joined) => joined.teamId === teamDeploymentId)!;
  const listed = await host.rpc["team.links.list"]({});
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.data.links.filter((link) => link.state !== "revoked");
}

const create = (coordinator: TeamCoordinator, slug = "acme") =>
  coordinator.createHostedTeam({
    name: "Acme",
    slug: slug as HostedTeamSlug,
    personalDeploymentId: personal,
  });

describe("TeamCoordinator", () => {
  const running: TeamCoordinator[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const coordinator of running.splice(0)) coordinator.dispose();
    vi.useRealTimers();
  });
  const track = <T extends { coordinator: TeamCoordinator }>(value: T) => {
    running.push(value.coordinator);
    return value;
  };

  it("follows a hosted team to ready, connects the agent and opens it", async () => {
    const { coordinator, opened, world } = track(start());
    const view = await create(coordinator);
    expect(coordinator.getSnapshot().watching).toBe(view.id);
    const seen = new Set<string>();
    coordinator.subscribe(() =>
      coordinator.getSnapshot().hostedTeams.forEach((team) => seen.add(team.stage)),
    );
    await until(() => opened.length === 1, "the team opened");
    expect([...seen]).toEqual(expect.arrayContaining(["reserving", "configuring", "ready"]));
    expect(opened[0]).toBe(view.deploymentId);
    expect(coordinator.getSnapshot()).toMatchObject({ hostedTeams: [], watching: null, ready: [] });
    expect(coordinator.getSnapshot().intents).toMatchObject([
      { teamDeploymentId: view.deploymentId, hostedTeamId: view.id, state: "connected" },
    ]);
    expect(world.joined()[0]?.bootstrap.member.role).toBe("owner");
  });

  it("announces instead of opening when the person kept working, even mid-connect", async () => {
    const { coordinator, opened, world } = track(start());
    const view = await create(coordinator);
    // Ready lands while the agent is still connecting; Keep working arrives during that wait.
    let release!: () => void;
    const join = world.personal.join.bind(world.personal);
    world.personal.join = async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return join(...args);
    };
    await until(() => release !== undefined, "the agent started connecting");
    coordinator.keepWorking(view.id);
    release();
    await until(() => coordinator.getSnapshot().ready.length === 1, "the ready notice");
    expect(opened).toEqual([]);
    expect(coordinator.getSnapshot().ready[0]).toMatchObject({ name: "Acme" });
    coordinator.dismissReady(view.id);
    expect(coordinator.getSnapshot().ready).toEqual([]);
  });

  it("resumes a setup after a restart from the persisted intent", async () => {
    const first = start();
    const view = await create(first.coordinator);
    first.coordinator.dispose();
    const second = track(start(first.world));
    await second.coordinator.resume();
    await until(
      () => second.coordinator.getSnapshot().ready.length === 1,
      "the resumed team ready",
    );
    expect(second.opened).toEqual([]);
    expect(second.coordinator.getSnapshot().intents).toMatchObject([
      { hostedTeamId: view.id, teamDeploymentId: view.deploymentId, state: "connected" },
    ]);
  });

  it("leaves a team set up on another device to Account's listing, entering nothing here", async () => {
    const { coordinator, world } = track(start());
    // Created on the phone; this computer holds no intent for it.
    const view = await world.account.createHostedTeam({
      requestId: crypto.randomUUID(),
      name: "Acme",
      slug: "acme" as HostedTeamSlug,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await world.account.hostedTeam(view.id))?.stage).toBe("ready");
    const exchange = vi.spyOn(world.sessions, "exchange");
    await coordinator.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(coordinator.getSnapshot()).toMatchObject({ hostedTeams: [], intents: [], ready: [] });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("keeps an offline computer pending and retries with a fresh code", async () => {
    const { coordinator, opened, world } = track(start());
    world.personalOnline = false;
    const codes = vi.spyOn(world.sessions, "createLinkCode");
    await create(coordinator);
    await until(() => opened.length === 1, "the team opened");
    expect(coordinator.getSnapshot().intents[0]?.state).toBe("pending-offline");
    world.personalOnline = true;
    await until(
      () => coordinator.getSnapshot().intents[0]?.state === "connected",
      "the agent connected once online",
    );
    expect(codes).toHaveBeenCalledTimes(2);
    expect(new Set(await Promise.all(codes.mock.results.map((r) => r.value)))).toHaveProperty(
      "size",
      2,
    );
  });

  it("retries a failed setup, and cancels one being set up", async () => {
    const { coordinator, opened } = track(start());
    const failing = await create(coordinator, "failing");
    await until(
      () => coordinator.getSnapshot().hostedTeams[0]?.stage === "failed",
      "the setup failed",
    );
    await coordinator.retryHostedTeam(failing.id);
    await until(() => opened.length === 1, "the retried team opened");

    const cancelled = await create(coordinator, "beta");
    await coordinator.deleteHostedTeam(cancelled.id);
    await until(
      () => coordinator.getSnapshot().hostedTeams.length === 0,
      "the cancelled team left the list",
    );
    expect(coordinator.getSnapshot().intents.map((intent) => intent.teamOrigin)).toEqual([
      "https://failing.teams.opensteer.com",
    ]);
    expect(coordinator.getSnapshot().watching).toBeNull();
  });

  it("joins with an invite as a member, and leaving clears the device", async () => {
    const { coordinator, opened, world } = track(start());
    const preview = await coordinator.previewInvite(world.sampleInviteUrl);
    expect(preview.teamName).toBe("Northwind");
    const entered = await coordinator.joinWithInvite({
      inviteUrl: world.sampleInviteUrl,
      personalDeploymentId: personal,
    });
    expect(entered).toMatchObject({ admitted: true, member: { role: "member" } });
    expect(entered.intent?.state).toBe("connected");
    expect(opened).toEqual([entered.teamDeploymentId]);
    const linkLeave = vi.spyOn(world.personal, "leave");
    await coordinator.leaveTeam(entered.teamDeploymentId);
    expect(linkLeave).toHaveBeenCalledWith(personal, entered.teamDeploymentId);
    expect(coordinator.getSnapshot().intents).toEqual([]);
    expect(world.joined()).toEqual([]);
  });

  it("keeps a joined team after a restart, and forgets it once the team turns the person away", async () => {
    const first = start();
    const entered = await first.coordinator.joinWithInvite({
      inviteUrl: first.world.sampleInviteUrl,
      personalDeploymentId: personal,
    });
    first.coordinator.dispose();
    const second = track(start(first.world));
    const restore = vi.spyOn(first.world.sessions, "restore");
    // Even while Account can't list hosted teams.
    vi.spyOn(first.world.account, "listHostedTeams").mockRejectedValueOnce(new Error("Offline"));
    await expect(second.coordinator.resume()).rejects.toThrow("Offline");
    await vi.waitFor(() =>
      expect(restore).toHaveBeenCalledWith({
        origin: entered.origin,
        teamDeploymentId: entered.teamDeploymentId,
      }),
    );
    expect(second.coordinator.getSnapshot().intents).toHaveLength(1);
    second.coordinator.dispose();
    // Removed meanwhile: the team no longer admits this Account.
    await first.world.sessions.forget(entered.teamDeploymentId);
    const third = track(start(first.world));
    await third.coordinator.resume();
    await vi.waitFor(() => expect(third.coordinator.getSnapshot().intents).toEqual([]));
  });

  it("keeps teams of a person with no computer across a restart, with no agent to connect", async () => {
    const first = start();
    const join = vi.spyOn(first.world.personal, "join");
    const created = await first.coordinator.createHostedTeam({
      name: "Acme",
      slug: "acme" as HostedTeamSlug,
      personalDeploymentId: null,
    });
    await until(() => first.opened.length === 1, "the created team opened");
    const entered = await first.coordinator.joinWithInvite({
      inviteUrl: first.world.sampleInviteUrl,
      personalDeploymentId: null,
    });
    expect(entered.intent).toMatchObject({ personalDeploymentId: null, state: "no-agent" });
    expect(first.opened).toHaveLength(2);
    const teams = [
      { origin: created.origin, teamDeploymentId: created.deploymentId },
      { origin: entered.origin, teamDeploymentId: entered.teamDeploymentId },
    ];
    expect(first.coordinator.getSnapshot().intents).toMatchObject(
      teams.map(({ teamDeploymentId }) => ({ teamDeploymentId, state: "no-agent" })),
    );
    first.coordinator.dispose();

    // Before Account's directory lists either team, a restart restores both.
    const second = track(start(first.world));
    const restore = vi.spyOn(first.world.sessions, "restore");
    await second.coordinator.resume();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    for (const team of teams) expect(restore).toHaveBeenCalledWith(team);
    expect(second.coordinator.getSnapshot().intents).toHaveLength(2);
    expect(join).not.toHaveBeenCalled();
  });

  it("refuses the last owner leaving and keeps everything", async () => {
    const { coordinator, opened } = track(start());
    await create(coordinator);
    await until(() => opened.length === 1, "the team opened");
    await expect(coordinator.leaveTeam(opened[0]!)).rejects.toThrow(/last owner/u);
    expect(coordinator.getSnapshot().intents[0]?.state).toBe("connected");
  });

  it("connects the agent to a team the preview seeded outside the world", async () => {
    const acme = new MockTeamHost({ origin: "https://chat.acme.example" });
    const { coordinator, world } = track(start(new MockTeamWorld({ seeded: () => [acme] })));
    const intent = await coordinator.connectAgent({
      teamDeploymentId: DeploymentIdSchema.parse(acme.teamId),
      origin: acme.origin,
      personalDeploymentId: personal,
    });
    expect(intent.state).toBe("connected");
    // Already shown by the preview itself, so the world doesn't list it a second time.
    expect(world.joined()).toEqual([]);
  });

  it("disconnects only the agent", async () => {
    const { coordinator, opened, world } = track(start());
    await create(coordinator);
    await until(() => opened.length === 1, "the team opened");
    const linkLeave = vi.spyOn(world.personal, "leave");
    await coordinator.disconnectAgent(opened[0]!);
    expect(linkLeave).toHaveBeenCalledOnce();
    expect(await activeLinks(world, opened[0]!)).toEqual([]);
    // The team itself stays on the device until Account's directory lists it.
    expect(coordinator.getSnapshot().intents).toMatchObject([
      { teamDeploymentId: opened[0], personalDeploymentId: null, state: "no-agent" },
    ]);
    expect(world.joined()).toHaveLength(1);
  });

  it("never reconnects an offline computer's retry that comes due while disconnecting", async () => {
    const { coordinator, opened, world } = track(start());
    world.personalOnline = false;
    await create(coordinator);
    await until(() => opened.length === 1, "the team opened");
    expect(coordinator.getSnapshot().intents[0]?.state).toBe("pending-offline");
    const codes = vi.spyOn(world.sessions, "createLinkCode");
    const revoked = Promise.withResolvers<void>();
    const revoke = world.sessions.revokeAgentLinks.bind(world.sessions);
    vi.spyOn(world.sessions, "revokeAgentLinks").mockImplementation(async (id) => {
      await revoked.promise;
      return revoke(id);
    });
    const disconnecting = coordinator.disconnectAgent(opened[0]!);
    world.personalOnline = true;
    // The retry's backoff passes while the team is still revoking.
    await vi.advanceTimersByTimeAsync(600_000);
    revoked.resolve();
    await disconnecting;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(codes).not.toHaveBeenCalled();
    expect(await activeLinks(world, opened[0]!)).toEqual([]);
    expect(coordinator.getSnapshot().intents).toMatchObject([{ state: "no-agent" }]);
  });

  it("stops a connection attempt in flight before it redeems its code or records it", async () => {
    const { coordinator, world } = track(start());
    const entered = await coordinator.joinWithInvite({
      inviteUrl: world.sampleInviteUrl,
      personalDeploymentId: null,
    });
    const minted = Promise.withResolvers<void>();
    const mint = world.sessions.createLinkCode.bind(world.sessions);
    vi.spyOn(world.sessions, "createLinkCode").mockImplementation(async (id) => {
      const offer = await mint(id);
      await minted.promise;
      return offer;
    });
    const join = vi.spyOn(world.personal, "join");
    const connecting = coordinator.connectAgent({
      teamDeploymentId: entered.teamDeploymentId,
      origin: entered.origin,
      personalDeploymentId: personal,
    });
    await vi.advanceTimersByTimeAsync(0);
    const disconnecting = coordinator.disconnectAgent(entered.teamDeploymentId);
    await vi.advanceTimersByTimeAsync(0);
    minted.resolve();
    await connecting;
    await disconnecting;
    expect(join).not.toHaveBeenCalled();
    expect(await activeLinks(world, entered.teamDeploymentId)).toEqual([]);
    expect(coordinator.getSnapshot().intents).toMatchObject([{ state: "no-agent" }]);
  });

  it("disconnects the agent link the team holds, wherever it was made, even with the computer off", async () => {
    const { coordinator, world } = track(start());
    const entered = await coordinator.joinWithInvite({
      inviteUrl: world.sampleInviteUrl,
      personalDeploymentId: null,
    });
    // A link this device never asked for: made on another device, or before it kept intents.
    const host = world.joined().find((joined) => joined.teamId === entered.teamDeploymentId)!;
    await host.rpc["commands.dispatch"]({ type: "team.link.code.create" });
    expect(await activeLinks(world, entered.teamDeploymentId)).toHaveLength(1);
    world.personalOnline = false;
    await coordinator.disconnectAgent(entered.teamDeploymentId);
    expect(await activeLinks(world, entered.teamDeploymentId)).toEqual([]);
  });

  it("joins in the browser with the invite when Account can't vouch yet, never when the team refuses", async () => {
    const { coordinator, world } = track(start());
    const signIn = vi.spyOn(world.sessions, "signIn");
    const exchange = vi
      .spyOn(world.sessions, "exchange")
      .mockRejectedValueOnce(
        new TeamEntryRefusedError("invite-invalid", "This invite no longer works."),
      );
    await expect(
      coordinator.joinWithInvite({
        inviteUrl: world.sampleInviteUrl,
        personalDeploymentId: personal,
      }),
    ).rejects.toThrow(/no longer works/u);
    expect(signIn).not.toHaveBeenCalled();
    // An Account replica from before identity grants answers the grant with a missing route.
    exchange.mockRejectedValueOnce(new TeamIdentityGrantUnsupportedError());
    const entered = await coordinator.joinWithInvite({
      inviteUrl: world.sampleInviteUrl,
      personalDeploymentId: personal,
    });
    expect(signIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ selector: expect.any(String) }),
    );
    expect(entered).toMatchObject({ admitted: true, intent: { state: "connected" } });
  });

  it("refuses a bad invite without recording anything", async () => {
    const { coordinator, world } = track(start());
    await expect(
      coordinator.joinWithInvite({
        inviteUrl: world.sampleInviteUrl.replace(/#.*/u, "#wrongVerifierwrongVerifierwrong00"),
        personalDeploymentId: personal,
      }),
    ).rejects.toThrow(/no longer works/u);
    expect(coordinator.getSnapshot().intents).toEqual([]);
  });

  it("joins an older team in the browser first, then signs in to it in the app", async () => {
    const { coordinator, world } = track(start());
    const verify = world.sessions.verify.bind(world.sessions);
    world.sessions.verify = async (origin) => ({ ...(await verify(origin)), capabilities: [] });
    const exchange = world.sessions.exchange.bind(world.sessions);
    // The previous invite page drops the app's `authorize` and never resumes its sign-in; only
    // its own "Join in the browser" admits the person, after which the app's sign-in works.
    const signIn = vi
      .spyOn(world.sessions, "signIn")
      .mockImplementation((team, invite) =>
        invite === null ? exchange(team, null) : new Promise(() => {}),
      );
    const invite = readTeamInvite(world.sampleInviteUrl)!;

    const cancelled = coordinator.joinWithInvite({
      inviteUrl: world.sampleInviteUrl,
      personalDeploymentId: personal,
    });
    await until(() => Boolean(coordinator.getSnapshot().joiningInBrowser), "the browser join");
    coordinator.cancelJoinInBrowser();
    await expect(cancelled).rejects.toThrow(/cancel/iu);
    expect(coordinator.getSnapshot().joiningInBrowser).toBeNull();
    expect(coordinator.getSnapshot().intents).toEqual([]);

    const browser = vi.spyOn(world.sessions, "joinInBrowser");
    const joining = coordinator.joinWithInvite({
      inviteUrl: world.sampleInviteUrl,
      personalDeploymentId: personal,
    });
    await until(() => Boolean(coordinator.getSnapshot().joiningInBrowser), "the browser join");
    expect(coordinator.getSnapshot().joiningInBrowser).toBe(invite.origin);
    expect(browser).toHaveBeenLastCalledWith(expect.anything(), invite.invite);
    expect(signIn).not.toHaveBeenCalled();
    coordinator.continueJoinInBrowser();
    const entered = await joining;
    expect(signIn.mock.calls.map(([, sent]) => sent)).toEqual([null]);
    expect(entered).toMatchObject({ admitted: true, intent: { state: "connected" } });
    expect(coordinator.getSnapshot().joiningInBrowser).toBeNull();
  });
});
