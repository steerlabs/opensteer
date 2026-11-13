import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "kysely";
import { createId, type TeamActor, type TeamInviteId, type UserId } from "@opensteer/core";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import type { IdentityService } from "@opensteer/identity";
import { teamInvitePreviewPath } from "@opensteer/protocol";
import { createTeamFixture } from "@opensteer/database/test-support/team";
import { TeamAccessStore, emptyTeamAccessEffects } from "@opensteer/database/team-access";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { TeamMembersStore } from "@opensteer/database/team-members";
import { createTeamInviteVerifierVault } from "./invite-verifier-vault.js";
import { registerTeamSetupRoutes } from "./setup-routes.js";
import { normalizeHostError } from "../server/http-errors.js";

describe("reusable team invites", () => {
  let fixture: Awaited<ReturnType<typeof createTeamFixture>>;
  let access: TeamAccessStore, invites: TeamInvitesStore, members: TeamMembersStore;
  let owner: TeamActor;
  beforeEach(async () => {
    fixture = await createTeamFixture();
    access = new TeamAccessStore(fixture.database);
    await access.initialize();
    invites = new TeamInvitesStore(
      access,
      "https://team.example.invalid",
      createTeamInviteVerifierVault("s".repeat(40), fixture.deploymentId),
    );
    members = new TeamMembersStore(access);
    owner = { kind: "human", userId: fixture.userId };
  });
  afterEach(async () => {
    await fixture?.close();
  });
  async function person(name: string, role?: "member" | "admin") {
    const userId = createId("user");
    await sql`insert into users(id,display_name,email,email_verified) values(${userId},${name},${`${name}@example.invalid`},true)`.execute(
      fixture.database,
    );
    if (role)
      await sql`insert into team_members(user_id,handle,role,state) values(${userId},${name.toLowerCase()},${role},'active')`.execute(
        fixture.database,
      );
    return userId;
  }
  function secret(url: string) {
    const parsed = new URL(url);
    return { selector: parsed.pathname.split("/").pop()!, verifier: parsed.hash.slice(1) };
  }
  async function join(userId: UserId, url: string) {
    const { selector, verifier } = secret(url);
    return invites.accept(userId, selector, verifier);
  }
  async function state(userId: UserId) {
    return (
      await fixture.database
        .selectFrom("teamMembers")
        .select("state")
        .where("userId", "=", userId)
        .executeTakeFirst()
    )?.state;
  }
  const refusal = (reason: string) => ({ code: "forbidden", reason });
  /** A manager pressing Reset on the link they see now. */
  const reset = async (
    expiresInDays: 1 | 7 | 30 = 7,
    maxUses: number | null = null,
    actor = owner,
  ) => {
    const seen = await fixture.database
      .selectFrom("teamInvites")
      .select("id")
      .where("sealedVerifier", "is not", null)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return invites.reset(actor, createId("teamInvite"), seen?.id ?? null, expiresInDays, maxUses);
  };

  it("lets only managers reset and redisplay the one current link", async () => {
    const admin: TeamActor = { kind: "human", userId: await person("Ada", "admin") };
    const member: TeamActor = { kind: "human", userId: await person("Mo", "member") };
    await expect(invites.current(owner)).resolves.toEqual({ invite: null });
    await expect(reset(7, null, member)).rejects.toMatchObject({ code: "forbidden" });
    await expect(invites.current(member)).rejects.toMatchObject({ code: "forbidden" });

    const first = await reset(7, null, admin);
    expect(first.url).toMatch(/^https:\/\/team\.example\.invalid\/invite\/[\w-]{32}#[\w-]{43}$/u);
    // Another manager, on any device, sees the same link: the verifier is sealed, not just hashed.
    expect((await invites.current(owner)).invite).toEqual(first);
    const stored = await fixture.database
      .selectFrom("teamInvites")
      .select("sealedVerifier")
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(stored.sealedVerifier?.toString("utf8")).not.toContain(secret(first.url).verifier);

    // A retried reset returns its own invite; a fresh reset replaces it in one transaction.
    await expect(invites.reset(owner, first.id, null, 30, 5)).resolves.toEqual(first);
    const second = await reset(30, 5);
    expect((await invites.current(owner)).invite).toEqual(second);
    await expect(invites.reset(owner, first.id, null, 7, null)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(join(await person("Late"), first.url)).rejects.toMatchObject(
      refusal("invite-invalid"),
    );
    // Revoking the current invite is the way out; nothing replaces it.
    await invites.revoke(owner, second.id);
    await expect(invites.current(owner)).resolves.toEqual({ invite: null });
    // The legacy list keeps its single-use shape and never shows reusable invites.
    expect((await invites.page(owner)).invites).toEqual([]);
  });

  it("never lets two managers revoke each other's link by opening or resetting at once", async () => {
    const admin: TeamActor = { kind: "human", userId: await person("Ada", "admin") };
    // Both sheets saw no link and make one together: they get the same one.
    const [mine, theirs] = await Promise.all([
      invites.reset(owner, createId("teamInvite"), null, 7, null),
      invites.reset(admin, createId("teamInvite"), null, 7, null),
    ]);
    expect(theirs).toEqual(mine);
    // Both pressed Reset on that link: one replaces it, the other is shown that replacement.
    const [one, other] = await Promise.all([
      invites.reset(owner, createId("teamInvite"), mine.id, 7, null),
      invites.reset(admin, createId("teamInvite"), mine.id, 7, null),
    ]);
    expect(other).toEqual(one);
    expect(one.id).not.toBe(mine.id);
    expect((await invites.current(owner)).invite).toEqual(one);
  });

  it("shows no link once the Host's secret changed, and a reset makes a working one", async () => {
    await reset();
    const rotated = new TeamInvitesStore(
      access,
      "https://team.example.invalid",
      createTeamInviteVerifierVault("r".repeat(40), fixture.deploymentId),
    );
    await expect(rotated.current(owner)).resolves.toEqual({ invite: null });
    const fresh = await rotated.reset(owner, createId("teamInvite"), null, 7, null);
    await expect(rotated.current(owner)).resolves.toEqual({ invite: fresh });
  });

  it("refuses an admission whose invite was reset after the person proved it", async () => {
    const old = await reset();
    const { selector } = secret(old.url);
    // A browser admission verified the link before sign-in; the reset lands in between.
    await invites.verify(selector, secret(old.url).verifier);
    await reset();
    const joiner = await person("Pat");
    await expect(
      access.mutate(async (t) => ({
        value: await invites.acceptInTransaction(t, joiner, selector),
        effects: emptyTeamAccessEffects,
      })),
    ).rejects.toMatchObject(refusal("invite-invalid"));
    expect(await state(joiner)).toBeUndefined();
  });

  it("never admits through a link after the reset that revoked it commits", async () => {
    for (let round = 0; round < 4; round++) {
      const old = await reset();
      const joiner = await person(`Racer${round}`);
      const [accepted, replaced] = await Promise.allSettled([join(joiner, old.url), reset()]);
      expect(replaced.status).toBe("fulfilled");
      const row = await fixture.database
        .selectFrom("teamInvites")
        .select(["usedCount", "revokedAt"])
        .where("id", "=", old.id)
        .executeTakeFirstOrThrow();
      const use = await fixture.database
        .selectFrom("teamInviteUses")
        .select("acceptedAt")
        .where("inviteId", "=", old.id)
        .executeTakeFirst();
      if (accepted.status === "fulfilled") {
        expect(row.usedCount).toBe(1);
        expect(use!.acceptedAt.getTime()).toBeLessThanOrEqual(row.revokedAt!.getTime());
      } else {
        expect(accepted.reason).toMatchObject(refusal("invite-invalid"));
        expect(row.usedCount).toBe(0);
        expect(await state(joiner)).toBeUndefined();
      }
      const current = await fixture.database
        .selectFrom("teamInvites")
        .select("id")
        .where("sealedVerifier", "is not", null)
        .where("revokedAt", "is", null)
        .execute();
      expect(current).toHaveLength(1);
    }
  });

  it("expires at exactly its chosen day count", async () => {
    for (const days of [1, 7, 30] as const) {
      const invite = await reset(days);
      expect(invite.expiresInDays).toBe(days);
      expect(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)).toBe(days * 86_400_000);
    }
    const invite = await reset(1);
    const setExpiry = (at: Date) =>
      fixture.database
        .updateTable("teamInvites")
        .set({ expiresAt: at })
        .where("id", "=", invite.id as TeamInviteId)
        .execute();
    await setExpiry(new Date(Date.now() - 1));
    await expect(invites.preview(secret(invite.url))).rejects.toMatchObject(
      refusal("invite-expired"),
    );
    await expect(join(await person("Tardy"), invite.url)).rejects.toMatchObject(
      refusal("invite-expired"),
    );
    await expect(invites.current(owner)).resolves.toEqual({ invite: null });
    await setExpiry(new Date(Date.now() + 60_000));
    const prompt = await person("Prompt");
    await join(prompt, invite.url);
    expect(await state(prompt)).toBe("active");
  });

  it("admits without limit, or until a capped invite is used up", async () => {
    const open = await reset(7, null);
    for (const name of ["A", "B", "C"]) await join(await person(name), open.url);
    expect((await invites.current(owner)).invite?.usedCount).toBe(3);

    const capped = await reset(7, 2);
    const first = await person("D");
    await join(first, capped.url);
    // Someone already in the team consumes nothing.
    await join(first, capped.url);
    await join(await person("E"), capped.url);
    await expect(join(await person("F"), capped.url)).rejects.toMatchObject(
      refusal("invite-used-up"),
    );
    await expect(invites.preview(secret(capped.url))).rejects.toMatchObject(
      refusal("invite-used-up"),
    );
    await expect(invites.current(owner)).resolves.toEqual({ invite: null });
  });

  it("keeps single-use invites working beside the reusable one", async () => {
    const legacy = await invites.create(owner, createId("teamInvite"));
    await reset();
    await join(await person("Once"), legacy.url);
    await expect(join(await person("Twice"), legacy.url)).rejects.toMatchObject(
      refusal("invite-used-up"),
    );
    const listed = (await invites.page(owner)).invites;
    expect(listed.map((invite) => [invite.id, invite.maxUses, invite.usedCount])).toEqual([
      [legacy.invite.id, 1, 1],
    ]);
  });

  it("re-admits a removed person only with an invite created after their removal", async () => {
    const before = await reset();
    const unusedLegacy = await invites.create(owner, createId("teamInvite"));
    const person1 = await person("Rex");
    await join(person1, before.url);
    await members.change(owner, person1, "remove");
    expect(await state(person1)).toBe("removed");

    await expect(join(person1, before.url)).rejects.toMatchObject(refusal("invite-invalid"));
    await expect(join(person1, unusedLegacy.url)).rejects.toMatchObject(refusal("invite-invalid"));
    // The same old link still works for someone who was never removed.
    await join(await person("Neve"), before.url);

    const after = await reset();
    const readmitted = await join(person1, after.url);
    expect(readmitted.state).toBe("active");
    expect(readmitted.role).toBe("member");
  });

  it("previews a valid invite with only its expiry and refuses every bad secret alike", async () => {
    const invite = await reset(7);
    const good = secret(invite.url);
    const http = Fastify();
    http.setErrorHandler((error, _request, reply) => {
      const normalized = normalizeHostError(error);
      void reply.status(normalized.status).send(normalized.error);
    });
    registerTeamSetupRoutes(http, {
      identity: {} as unknown as IdentityService,
      invites,
      teamName: "Acme",
      accountPortalOrigin: "https://account.example.invalid",
    });
    const preview = (body: unknown) =>
      http.inject({
        method: "POST",
        url: teamInvitePreviewPath,
        headers: { [teamApiVersionHeader]: String(teamApiVersion) },
        payload: body as Record<string, string>,
      });
    try {
      const ok = await preview(good);
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.json()).toEqual({ teamName: "Acme", expiresAt: invite.expiresAt });

      const revoked = await invites.create(owner, createId("teamInvite"));
      await invites.revoke(owner, revoked.invite.id);
      const bad = [
        { ...good, verifier: "x".repeat(43) },
        { ...good, selector: "y".repeat(32) },
        secret(revoked.url),
      ];
      const refusals = await Promise.all(bad.map(preview));
      for (const response of refusals) {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(refusals[0]!.json());
        expect(response.json()).toMatchObject({ reason: "invite-invalid" });
      }

      const page = await http.inject({ method: "GET", url: `/invite/${good.selector}` });
      expect(page.statusCode).toBe(200);
      expect(page.headers["referrer-policy"]).toBe("no-referrer");
      expect(page.body).not.toContain(good.verifier);
    } finally {
      await http.close();
    }
  });
});
