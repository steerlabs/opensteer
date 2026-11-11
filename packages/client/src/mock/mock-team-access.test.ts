import { TeamCommandResultSchema, hostApi, teamReadSchemas } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "../host/client.js";
import { TeamAccess, createTeamInvitationDraft } from "../host/team-access.js";
import { MockHostClient } from "./mock-host-client.js";
import {
  mockTeamInvitation,
  mockTeamProjects,
  mockTeamScenarios,
  type MockTeamScenario,
} from "./mock-team-access.js";

const sam = "usr_00000000-0000-4000-8000-0000000000a3";
const viewer = "usr_0192f4a1-0000-4000-8000-000000000001";

/** Every team read, with an input each scenario's fixtures can answer. */
const reads = {
  "team.projects.list": {},
  "team.computer.get": {},
  "team.invitations.list": {},
  "team.summary.get": {},
  "team.people.list": { limit: 3 },
  "team.member.get": { userId: sam },
  "team.directory.search": { workspaceId: mockTeamProjects.launch, query: "s" },
  "team.groups.list": {},
  "team.group.get": { groupId: "00000000-0000-4000-9000-000000000002" },
  "team.project.access.get": { workspaceId: mockTeamProjects.launch },
  "team.access.explain": {
    workspaceId: mockTeamProjects.launch,
    subject: { kind: "person", userId: sam },
  },
  "team.access.preview": {
    expectedRevision: 41,
    changes: [{ kind: "revoke", entryId: "00000000-0000-4000-a000-000000000003" }],
  },
  "team.member.preview": { userId: sam, change: { kind: "set-state", value: "suspended" } },
  "team.audit.list": {},
  "team.project.settings.get": { workspaceId: mockTeamProjects.launch },
  "team.project.runtimeChoices": { workspaceId: mockTeamProjects.launch },
  "team.invitation.preview": { selector: mockTeamInvitation.selector },
  "team.invitation.exchange": mockTeamInvitation,
  "team.invitation.accept": {},
} satisfies { [Name in keyof typeof teamReadSchemas]: unknown };

function client(team: MockTeamScenario) {
  return new MockHostClient({ team });
}

describe("the shared team mock", () => {
  it("shares a read-only task card without counting it or accepting its answer", async () => {
    const host = client("member");
    try {
      const request = Object.values(host.getSnapshot().requests)
        .flat()
        .find(
          (row) =>
            row.status === "pending" &&
            row.answer?.allowed === false &&
            row.answer.reason === "requester-only",
        );
      if (!request || request.presentation.kind !== "choice")
        throw new Error("Missing shared read-only question fixture");
      const option = request.presentation.options[0];
      if (!option) throw new Error("Question has no option");
      const page = await host.rpc["thread.requests.list"]({
        threadId: request.originatingThreadId,
      });
      expect(page.ok ? page.data.requests : null).toContainEqual(request);
      const needsYou = await host.rpc["requests.list"]({});
      expect(
        needsYou.ok ? needsYou.data.requests.some((row) => row.request.id === request.id) : true,
      ).toBe(false);
      const refused = await host.rpc["commands.dispatch"]({
        type: "request.respond",
        idempotencyKey: "read-only-answer",
        requestId: request.id,
        response: { kind: "choice", optionId: option.id },
      });
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        error: { code: "forbidden", reason: "requester-only" },
      });
      expect(
        host
          .getSnapshot()
          .requests[request.originatingThreadId]?.find((row) => row.id === request.id)?.status,
      ).toBe("pending");
      const own = Object.values(host.getSnapshot().requests)
        .flat()
        .find(
          (row) =>
            row.status === "pending" && row.requiredActor === "requester" && row.answer?.allowed,
        );
      if (!own || own.presentation.kind !== "choice" || !own.presentation.options[0])
        throw new Error("Missing answerable question fixture");
      const answered = await host.rpc["commands.dispatch"]({
        type: "request.respond",
        idempotencyKey: "own-answer",
        requestId: own.id,
        response: { kind: "choice", optionId: own.presentation.options[0].id },
      });
      expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
    } finally {
      host.dispose();
    }
  });

  it.each(mockTeamScenarios)(
    "answers every team read in the %s scenario with the real schemas",
    async (scenario) => {
      const host = client(scenario);
      expect(host.getSnapshot().teamAdministrationAvailable).toBe(scenario !== "absent");
      for (const [name, input] of Object.entries(reads) as [keyof typeof reads, unknown][]) {
        const call = host.rpc[name] as (
          input: unknown,
        ) => Promise<{ ok: boolean; data?: unknown; error?: { reason?: string } }>;
        const result = await call(input);
        if (scenario === "admin") expect(result.ok ? null : result.error, name).toBeNull();
        if (result.ok) {
          expect(() => teamReadSchemas[name].output.parse(result.data), name).not.toThrow();
        } else {
          expect(hostApi[name].error.safeParse(result.error).success, name).toBe(true);
          if (scenario === "absent") expect(result.error?.reason, name).toBe("team-unavailable");
        }
      }
      host.dispose();
    },
  );

  it("answers every team command with the real result schema", async () => {
    const host = client("admin");
    const team = new TeamAccess(host);
    const revision = async () => (await team.summary()).accessRevision;
    expect((await team.member({ userId: sam })).can.setKind).toEqual({
      allowed: false,
      reason: "guests-unavailable",
    });
    await expect(
      team.changeMember(await revision(), sam, { kind: "set-kind", value: "guest" }),
    ).rejects.toMatchObject({ reason: "guests-unavailable" });
    await expect(
      team.previewMember("usr_00000000-0000-4000-8000-000000000099", {
        kind: "set-kind",
        value: "guest",
      }),
    ).rejects.toMatchObject({ reason: "guests-unavailable" });
    const guestInvite = createTeamInvitationDraft();
    expect(
      await host.rpc["commands.dispatch"]({
        type: "team.invitation.create",
        id: guestInvite.id,
        selector: guestInvite.selector,
        tokenHash: guestInvite.tokenHash,
        idempotencyKey: guestInvite.idempotencyKey,
        expectedRevision: await revision(),
        memberKind: "guest",
        intendedEmail: "guest@example.test",
        trustedComputerConfirmed: true,
        validFor: "1d",
      }),
    ).toMatchObject({ ok: false, error: { reason: "guests-unavailable" } });
    const results: unknown[] = [
      await team.createProject(await revision(), { name: "Support", color: "sky" }),
      await team.applyAccess(await revision(), [
        { kind: "create-group", id: "00000000-0000-4000-9000-0000000000aa", name: "Design" },
      ]),
      await team.selfGrant(await revision(), mockTeamProjects.payroll),
      await team.changeMember(await revision(), sam, { kind: "set-administrator", value: true }),
      await team.revokeConnection(await revision(), "mcn_00000000-0000-4000-8000-0000000000d3"),
      await team.setProjectSettings(await revision(), mockTeamProjects.launch, 3, {
        harnessInstanceId: "hin_00000000-0000-4000-8000-0000000000c2" as never,
        modelSelection: {
          modelId: "gpt-5.6-sol" as never,
          providerId: "openai" as never,
          options: {},
        },
        accessMode: "auto",
        instructions: "",
        timeZone: "Europe/London",
      }),
    ];
    const shown = (await team.computer()).computer!.id;
    expect((await team.computer()).can.replace).toEqual({
      allowed: false,
      reason: "projects-prevent-replacement",
    });
    await expect(team.replaceComputer(await revision(), shown)).rejects.toMatchObject({
      reason: "projects-prevent-replacement",
    });
    // Deleting a Project takes it from everyone's snapshot, and asking again changes nothing.
    const { finance } = mockTeamProjects;
    expect(host.getSnapshot().workspaces.some(({ id }) => id === finance)).toBe(true);
    results.push(await team.deleteProject(await revision(), finance));
    await team.deleteProject(await revision(), finance);
    expect(host.getSnapshot().workspaces.some(({ id }) => id === finance)).toBe(false);
    const draft = createTeamInvitationDraft();
    const created = await team.createInvitation(await revision(), draft, {
      email: "nina2@acme.example",
      validFor: "1d",
      trustedComputerConfirmed: true,
    });
    const listed = async () =>
      (await new TeamAccess(host).invitations()).items.find(
        ({ id }) => id === created.invitationId,
      );
    expect(await listed()).toMatchObject({ state: "open", can: { revoke: { allowed: true } } });
    // Another device has no secret, only the listed id, and can still revoke.
    const elsewhere = new TeamAccess(host);
    results.push(created, await elsewhere.revokeInvitation(await revision(), (await listed())!.id));
    expect(await listed()).toMatchObject({ state: "revoked", can: { revoke: { allowed: false } } });
    for (const project of (await team.projects()).items)
      await team.deleteProject(await revision(), project.id);
    expect((await team.computer()).can.replace).toEqual({ allowed: true });
    // A screen that still shows the computer it read is fenced off once that computer is replaced.
    results.push(await team.replaceComputer(await revision(), shown));
    expect((await team.computer()).computer).toBeNull();
    await expect(team.replaceComputer(await revision(), shown)).rejects.toMatchObject({
      reason: "team-object-unavailable",
    });
    for (const result of results) expect(() => TeamCommandResultSchema.parse(result)).not.toThrow();
    expect(new Set(results.map((result) => TeamCommandResultSchema.parse(result).type)).size).toBe(
      10,
    );
    host.dispose();
  });

  it("sets up a fresh team server only once its owner acknowledges who it is for", async () => {
    const host = client("fresh");
    expect(host.getSnapshot()).toMatchObject({
      session: "authentication-required",
      identityConfig: { setupState: "required" },
    });
    const claim = { email: "alex@acme.example", kind: "password", password: "correct horse 42" };
    const refused = await host.rpc["auth.setup.claim"](claim as never).catch(
      (error: unknown) => error,
    );
    expect(refused instanceof Error || (refused as { ok?: boolean }).ok === false).toBe(true);
    expect(host.getSnapshot().identityConfig?.setupState).toBe("required");
    await host.rpc["auth.setup.claim"]({ ...claim, trustedMembersAcknowledged: true } as never);
    expect(host.getSnapshot()).toMatchObject({
      session: "authenticated",
      identityConfig: { setupState: "complete" },
    });
    host.dispose();
  });

  it("refuses a stale revision once, then applies against the fresh one", async () => {
    const host = client("admin-stale");
    const team = new TeamAccess(host);
    const before = await team.summary();
    const change = [{ kind: "revoke", entryId: "00000000-0000-4000-a000-000000000003" }] as const;
    const refused = await team
      .applyAccess(before.accessRevision, change)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HostClientRequestError);
    expect((refused as HostClientRequestError).reason).toBe("access-revision-changed");
    const after = await team.summary();
    expect(after.accessRevision).toBeGreaterThan(before.accessRevision);
    const preview = await team.previewAccess(after.accessRevision, change);
    expect(preview.counts.peopleLosing).toBe(0);
    expect(preview.surviving).toMatchObject([{ userId: sam, level: "use" }]);
    await expect(team.applyAccess(after.accessRevision, change)).resolves.toMatchObject({
      type: "team.access.apply",
    });
    host.dispose();
  });

  it("serves the last administrator's refusal as the Host's can, and lifts it with a second admin", async () => {
    const host = client("admin");
    const team = new TeamAccess(host);
    const me = await team.member({ userId: viewer });
    expect(me.can.setAdministrator).toEqual({ allowed: false, reason: "last-active-admin" });
    await team.changeMember((await team.summary()).accessRevision, sam, {
      kind: "set-administrator",
      value: true,
    });
    expect((await team.member({ userId: viewer })).can.setAdministrator).toEqual({ allowed: true });
    host.dispose();
  });
});
