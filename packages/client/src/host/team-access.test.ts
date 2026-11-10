import {
  TeamCommandSchema,
  TeamInvitationSelectorSchema,
  TeamInvitationVerifierSchema,
  type AccessExplanation,
  type HostApiCommandInput,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import type { HostClient } from "./client.js";
import {
  TeamAccess,
  changeLevelChanges,
  createTeamInvitationDraft,
  parseTeamInvitationUrl,
  teamInvitationTokenHash,
  teamInvitationUrl,
} from "./team-access.js";
import { accessPaths } from "./team-presentation.js";

describe("team invitation material", () => {
  it("keeps the verifier on this device: only its digest is sent, and only the fragment carries it", async () => {
    const draft = createTeamInvitationDraft();
    expect(TeamInvitationSelectorSchema.safeParse(draft.selector).success).toBe(true);
    expect(TeamInvitationVerifierSchema.safeParse(draft.verifier).success).toBe(true);
    expect(draft.tokenHash).toBe(teamInvitationTokenHash(draft.verifier));
    // The Host's digestSecret: hex SHA-256 of the UTF-8 text.
    expect(teamInvitationTokenHash("mockTeamInviteVerifier000000000000000000001")).toBe(
      "3e6618d07c99c5cf76511ad76115362f1c0fc5f33a09f528905d3d66fbb3d351",
    );

    const url = new URL(teamInvitationUrl("https://acme.example/app", draft));
    expect(url.pathname).toBe(`/join/${draft.selector}`);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${draft.verifier}`);
    expect(parseTeamInvitationUrl(url.href)).toEqual({
      selector: draft.selector,
      verifier: draft.verifier,
    });

    const sent: HostApiCommandInput[] = [];
    const team = new TeamAccess({
      dispatch: async (command) => {
        sent.push(command);
        if (sent.length === 1) throw new Error("The response was lost.");
        return {
          type: "team.invitation.create",
          accessRevision: 8,
          commandId: "cmd_00000000-0000-4000-8000-000000000001",
          invitationId: draft.id,
          selector: draft.selector,
          expiresAt: "2026-11-17T09:00:00.000Z",
        } as Awaited<ReturnType<HostClient["dispatch"]>>;
      },
      rpc: {} as HostClient["rpc"],
    });
    const input = { email: "nina@acme.example", kind: "full", validFor: "7d" } as const;
    await expect(team.createInvitation(7, draft, input)).rejects.toThrow("lost");
    await team.createInvitation(7, draft, input);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    const command = TeamCommandSchema.parse(sent[0]);
    expect(command).toMatchObject({ type: "team.invitation.create", tokenHash: draft.tokenHash });
    expect(JSON.stringify(sent)).not.toContain(draft.verifier);
  });

  it("rejects links whose verifier is missing or not in the fragment", () => {
    const draft = createTeamInvitationDraft();
    expect(parseTeamInvitationUrl(`https://acme.example/join/${draft.selector}`)).toBeNull();
    expect(
      parseTeamInvitationUrl(`https://acme.example/join/${draft.selector}?v=${draft.verifier}`),
    ).toBeNull();
  });
});

describe("access changes", () => {
  it("changes a level by revoking the entry and granting a new one, in that order", () => {
    const changes = changeLevelChanges(
      {
        id: "00000000-0000-4000-a000-000000000003",
        subject: { kind: "person", userId: "usr_00000000-0000-4000-8000-0000000000a3" as never },
        target: { workspaceId: "wsp_00000000-0000-4000-8000-000000000002" },
      },
      "manage",
      "00000000-0000-4000-a000-0000000000ff",
    );
    expect(
      TeamCommandSchema.parse({
        type: "team.access.apply",
        idempotencyKey: "k",
        expectedRevision: 1,
        changes,
      }),
    ).toMatchObject({
      changes: [
        { kind: "revoke", entryId: "00000000-0000-4000-a000-000000000003" },
        { kind: "grant", id: "00000000-0000-4000-a000-0000000000ff", level: "manage" },
      ],
    });
  });

  it("reads every way a person reaches a Project from the explanation graph", () => {
    const person = { kind: "person", userId: "usr_00000000-0000-4000-8000-0000000000a3" } as const;
    const entry = (
      id: string,
      subject: AccessExplanation["entries"][number]["subject"],
      level: "use" | "manage",
    ) => ({
      id,
      subject,
      target: { kind: "project" as const, workspaceId: "wsp_00000000-0000-4000-8000-000000000002" },
      level,
      grantedBy: { id: "usr_00000000-0000-4000-8000-0000000000a1", name: "Maya Chen" },
      grantedAt: "2026-10-05T09:30:00.000Z",
      revokedAt: null,
      can: { change: { allowed: true }, revoke: { allowed: true } },
    });
    const support = "00000000-0000-4000-9000-000000000003";
    const success = "00000000-0000-4000-9000-000000000002";
    const explanation = {
      accessRevision: 4,
      subject: person,
      target: { kind: "project", workspaceId: "wsp_00000000-0000-4000-8000-000000000002" },
      effectiveLevel: "use",
      entries: [
        entry(
          "00000000-0000-4000-a000-000000000001",
          { kind: "group", groupId: success, name: "Customer success" },
          "use",
        ),
        entry(
          "00000000-0000-4000-a000-000000000003",
          { ...person, name: "Sam Lee" } as never,
          "use",
        ),
      ],
      groups: [
        { id: support, name: "Support team", builtin: null },
        { id: success, name: "Customer success", builtin: null },
      ],
      edges: [
        { groupId: support, member: person },
        { groupId: success, member: { kind: "group", groupId: support } },
      ],
      truncated: false,
      nextCursor: null,
    } as unknown as AccessExplanation;
    expect(
      accessPaths(explanation).map(({ via, entry }) => [entry.id, via.map((g) => g.name)]),
    ).toEqual([
      ["00000000-0000-4000-a000-000000000003", []],
      ["00000000-0000-4000-a000-000000000001", ["Support team", "Customer success"]],
    ]);
  });
});
