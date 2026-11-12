import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import type { HostedTeamSlug } from "@opensteer/control-plane-protocol/hosted-teams";
import { MockTeamWorld } from "./mock-hosted-teams.js";
import {
  createTeamCoordinator,
  TeamNeedsBrowserError,
  type TeamCoordinator,
} from "./team-coordinator.js";

const personal = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000cc");

function start(world = new MockTeamWorld()) {
  const opened: DeploymentId[] = [];
  const coordinator = createTeamCoordinator({
    account: world.account,
    sessions: world.sessions,
    personal: world.personal,
    intents: world.intents,
    surface: "desktop",
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

  it("lets a person with no computer create and join, with no agent to connect", async () => {
    const { coordinator, opened, world } = track(start());
    const join = vi.spyOn(world.personal, "join");
    await coordinator.createHostedTeam({
      name: "Acme",
      slug: "acme" as HostedTeamSlug,
      personalDeploymentId: null,
    });
    await until(() => opened.length === 1, "the created team opened");
    const entered = await coordinator.joinWithInvite({
      inviteUrl: world.sampleInviteUrl,
      personalDeploymentId: null,
    });
    expect(entered.intent).toBeNull();
    expect(opened).toHaveLength(2);
    expect(coordinator.getSnapshot().intents).toEqual([]);
    expect(join).not.toHaveBeenCalled();
  });

  it("refuses the last owner leaving and keeps everything", async () => {
    const { coordinator, opened } = track(start());
    await create(coordinator);
    await until(() => opened.length === 1, "the team opened");
    await expect(coordinator.leaveTeam(opened[0]!)).rejects.toThrow(/last owner/u);
    expect(coordinator.getSnapshot().intents[0]?.state).toBe("connected");
  });

  it("disconnects only the agent", async () => {
    const { coordinator, opened, world } = track(start());
    await create(coordinator);
    await until(() => opened.length === 1, "the team opened");
    const linkLeave = vi.spyOn(world.personal, "leave");
    await coordinator.disconnectAgent(opened[0]!);
    expect(linkLeave).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().intents).toEqual([]);
    expect(world.joined()).toHaveLength(1);
  });

  it("refuses a bad invite without recording anything, and sends old servers to the browser", async () => {
    const { coordinator, world } = track(start());
    await expect(
      coordinator.joinWithInvite({
        inviteUrl: world.sampleInviteUrl.replace(/#.*/u, "#wrongVerifierwrongVerifierwrong00"),
        personalDeploymentId: personal,
      }),
    ).rejects.toThrow(/no longer works/u);
    expect(coordinator.getSnapshot().intents).toEqual([]);
    const verify = world.sessions.verify.bind(world.sessions);
    world.sessions.verify = async (origin) => ({ ...(await verify(origin)), capabilities: [] });
    await expect(
      coordinator.joinWithInvite({
        inviteUrl: world.sampleInviteUrl,
        personalDeploymentId: personal,
      }),
    ).rejects.toBeInstanceOf(TeamNeedsBrowserError);
  });
});
