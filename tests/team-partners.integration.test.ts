import { PartnerSocket } from "../apps/host/src/team-partners/socket.js";
import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createId } from "../packages/core/src/index.js";
import {
  HostDescriptorSchema,
  apiVersionHeaders,
} from "../packages/deployment-authority/src/index.js";
import {
  hostApi,
  parseTeamPartnerOffer,
  serializeTeamPartnerOffer,
  teamPartnerSocketPath,
} from "../packages/protocol/src/index.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { startTeamSystem } from "./team-system.test-support.js";
import { signHostDiscovery } from "../apps/host/src/identity/host-keys.js";

import {
  pairFixture,
  command,
  list,
  invite,
  redeem,
  active,
} from "./team-partners.test-support.js";
type Host = Awaited<ReturnType<typeof startTeamSystem>>;
type Session = Awaited<ReturnType<Host["session"]>>;

function preview(session: Session, offer: string) {
  return withTimeout(session.rpc["team.partner.invite.preview"]({ offer }), 5000, {
    timeoutError: () => new Error("Partner invite preview never returned"),
  });
}

it.each(["listener", "dialer"] as const)(
  "pairs real team Hosts, reconnects, and revokes from the %s before returning",
  async (revoker) => {
    const f = await pairFixture();
    try {
      const offer = await invite(f.aSession);
      if (revoker === "listener") {
        expect(await f.bSession.rpc["team.sharing.policy.get"]({})).toMatchObject({
          ok: true,
          data: { canSet: true, canPropose: true },
        });
        expect(await preview(f.bSession, offer)).toMatchObject({
          ok: true,
          data: { name: "Alpha", origin: f.a.canonicalOrigin },
        });
        expect(await list(f.aSession)).toEqual([]);
        expect(await list(f.bSession)).toEqual([]);
        expect(await f.aSession.rpc["team.partner.invites.list"]({})).toMatchObject({
          ok: true,
          data: { invites: [{ consumedAt: null, canRevoke: true }] },
        });
        const tampered = serializeTeamPartnerOffer({
          ...parseTeamPartnerOffer(offer),
          hostKeyFingerprint: `sha256:${"B".repeat(43)}`,
        });
        expect(await preview(f.bSession, tampered)).toMatchObject({
          ok: false,
          error: { reason: "identity-mismatch" },
        });
      }
      const bLink = await redeem(f.bSession, offer);
      const aLink = (await list(f.aSession))[0]!;
      expect(aLink).toMatchObject({
        role: "listener",
        state: "pending",
        localApproved: false,
        partnerApproved: true,
        canApprove: true,
      });
      expect(bLink).toMatchObject({
        partnerName: "Alpha",
        role: "dialer",
        state: "pending",
        localApproved: true,
        partnerApproved: false,
      });
      const stored = await f.a.database
        .selectFrom("teamPartnerInvites")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(stored)).not.toContain(parseTeamPartnerOffer(offer).verifier);
      expect(stored.consumedAt).not.toBeNull();
      await command(f.aSession, { type: "team.partner.approve", linkId: aLink.id });
      await active(f.aSession, f.bSession);

      const before = (await list(f.bSession))[0]!.lastSeenAt!;
      for (const socket of f.sockets) socket.terminate();
      await vi.waitFor(
        async () => {
          const row = (await list(f.bSession))[0]!;
          expect(
            row.lastSeenAt,
            "Partner did not reconnect with a new authenticated session",
          ).not.toBe(before);
          expect(row.connected).toBe(true);
        },
        { timeout: 5000 },
      );

      const session = revoker === "listener" ? f.aSession : f.bSession;
      const id = revoker === "listener" ? aLink.id : bLink.id;
      await command(session, { type: "team.partner.revoke", linkId: id });
      expect((await list(session))[0]).toMatchObject({
        state: "revoked",
        connected: false,
        revokedBy: "local",
      });
      const local = revoker === "listener" ? f.a : f.b;
      expect(
        local.host.app.websocketServer.clients.size,
        "Revocation returned while its partner socket remained open",
      ).toBe(0);
      await vi.waitFor(
        async () => {
          expect((await list(revoker === "listener" ? f.bSession : f.aSession))[0]).toMatchObject({
            state: "revoked",
            connected: false,
            revokedBy: "partner",
          });
        },
        { timeout: 3000 },
      );
      if (revoker === "listener") {
        const fresh = await redeem(f.bSession, await invite(f.aSession));
        const proposed = (await list(f.aSession)).find((row) => row.state === "pending")!;
        await command(f.aSession, { type: "team.partner.approve", linkId: proposed.id });
        await active(f.aSession, f.bSession);
        await command(f.aSession, { type: "team.partner.revoke", linkId: aLink.id });
        expect(
          (await list(f.bSession)).find((row) => row.id === fresh.id),
          "An old revocation ended the new pairing",
        ).toMatchObject({ state: "active", connected: true });
      }
      expect((await f.aSession.rpc["team.bootstrap.get"]({})).ok).toBe(true);
      const audit = await f.a.database
        .selectFrom("teamAudit")
        .select("action")
        .where("action", "like", "partner.%")
        .execute();
      expect(audit.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          "partner.invite.created",
          "partner.proposed",
          "partner.approved",
          "partner.connected",
          "partner.revoked",
        ]),
      );
    } finally {
      await f.close();
    }
  },
);

it("enforces members-propose independently on both teams and closes sockets when sharing is turned off", async () => {
  const f = await pairFixture();
  try {
    async function member(host: Host, owner: Session, name: string) {
      const result = await command(owner, {
        type: "team.invite.create",
        id: createId("teamInvite"),
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (result.type !== "team.invite.create") throw new Error("No member invite");
      return host.session(await host.acceptInvite(result.url, name), name);
    }
    const [am, bm] = await Promise.all([
      member(f.a, f.aSession, "Alice"),
      member(f.b, f.bSession, "Bob"),
    ]);
    expect((await am.rpc["commands.dispatch"]({ type: "team.partner.invite.create" })).ok).toBe(
      false,
    );
    expect(await am.rpc["team.sharing.policy.get"]({})).toMatchObject({
      ok: true,
      data: { canSet: false, canPropose: false },
    });
    await command(f.aSession, { type: "team.sharing.policy.set", policy: "members-propose" });
    await command(f.bSession, { type: "team.sharing.policy.set", policy: "members-propose" });
    expect(await am.rpc["team.sharing.policy.get"]({})).toMatchObject({
      ok: true,
      data: { canSet: false, canPropose: true },
    });
    const bLink = await redeem(bm, await invite(am));
    const aLink = (await list(am))[0]!;
    expect(aLink).toMatchObject({ localApproved: false, partnerApproved: false });
    expect(bLink).toMatchObject({ localApproved: false, partnerApproved: false });
    expect(
      (await bm.rpc["commands.dispatch"]({ type: "team.partner.approve", linkId: bLink.id })).ok,
    ).toBe(false);
    await command(f.aSession, { type: "team.partner.approve", linkId: aLink.id });
    await command(f.bSession, { type: "team.partner.approve", linkId: bLink.id });
    await active(am, bm);
    await command(f.bSession, { type: "team.sharing.policy.set", policy: "off" });
    expect((await list(bm))[0]!.connected).toBe(false);
    expect(f.b.host.app.websocketServer.clients.size).toBe(0);
    expect((await bm.rpc["commands.dispatch"]({ type: "team.partner.invite.create" })).ok).toBe(
      false,
    );
    await command(f.bSession, { type: "team.sharing.policy.set", policy: "members" });
    await active(am, bm);
    await command(f.bSession, { type: "team.partner.revoke", linkId: bLink.id });
    await vi.waitFor(
      async () =>
        expect((await list(am))[0]!.state, "Remote revocation never reached Alpha").toBe("revoked"),
      { timeout: 3000 },
    );
    await command(f.aSession, { type: "team.sharing.policy.set", policy: "members" });
    expect(await redeem(bm, await invite(am))).toMatchObject({
      state: "active",
      localApproved: true,
      partnerApproved: true,
    });
    await active(am, bm);
  } finally {
    await f.close();
  }
});

it("refuses expired, revoked and foreign redemptions while acknowledging the verified dialer again", async () => {
  const f = await pairFixture();
  try {
    const partners = f.a.host.team.partners!;
    const descriptor = HostDescriptorSchema.parse(
      (await f.b.host.app.inject({ url: "/.well-known/opensteer" })).json(),
    );
    const offer = parseTeamPartnerOffer(await invite(f.aSession));
    const accept = (verifier = offer.verifier) =>
      partners.store.accept(offer.selector, verifier, descriptor.authority, "Bravo", true);
    await expect(accept("A".repeat(43))).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (
        await f.a.database
          .selectFrom("teamPartnerInvites")
          .select("consumedAt")
          .where("id", "=", offer.selector)
          .executeTakeFirstOrThrow()
      ).consumedAt,
    ).toBeNull();
    await f.a.database
      .updateTable("teamPartnerInvites")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("id", "=", offer.selector)
      .execute();
    await expect(accept()).rejects.toMatchObject({ code: "forbidden" });
    await f.a.database
      .updateTable("teamPartnerInvites")
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where("id", "=", offer.selector)
      .execute();
    const results = await Promise.allSettled([accept(), accept()]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const accepted = await accept();
    expect(accepted.id).toBe(offer.selector);
    await expect(
      partners.store.accept(offer.selector, offer.verifier, partners.authority, "Other", true),
    ).rejects.toMatchObject({ reason: "identity-mismatch" });
    const revoked = parseTeamPartnerOffer(await invite(f.aSession));
    await command(f.aSession, { type: "team.partner.invite.revoke", inviteId: revoked.selector });
    await expect(
      partners.store.accept(
        revoked.selector,
        revoked.verifier,
        descriptor.authority,
        "Bravo",
        true,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await f.close();
  }
});

it("refuses changed keys and instances on reconnect without silently repinning", async () => {
  const f = await pairFixture();
  try {
    await redeem(f.bSession, await invite(f.aSession));
    await command(f.aSession, {
      type: "team.partner.approve",
      linkId: (await list(f.aSession))[0]!.id,
    });
    await active(f.aSession, f.bSession);
    const descriptor = HostDescriptorSchema.parse(
      (await f.a.host.app.inject({ url: "/.well-known/opensteer" })).json(),
    );
    const changed = signHostDiscovery(generateKeyPairSync("ed25519"), {
      ...descriptor.authority.document,
      hostInstanceId: createId("hostInstance"),
    });
    const before = f.discoveries;
    f.override.set(f.a.canonicalOrigin, { ...descriptor, authority: changed });
    for (const socket of f.sockets) socket.terminate();
    await vi.waitFor(
      () =>
        expect(f.discoveries, "Dialer never checked discovery on reconnect").toBeGreaterThan(
          before,
        ),
      { timeout: 5000 },
    );
    const link = (await list(f.bSession))[0]!;
    await vi.waitFor(
      async () => {
        expect(
          (await list(f.bSession))[0],
          "Changed identity did not suspend the link",
        ).toMatchObject({
          state: "pending",
          localApproved: false,
          lastError: "identity-mismatch",
          connected: false,
          canApprove: false,
        });
      },
      { timeout: 3000 },
    );
    expect(
      (await f.bSession.rpc["commands.dispatch"]({ type: "team.partner.approve", linkId: link.id }))
        .ok,
    ).toBe(false);
    expect(link.partnerHostInstanceId).toBe(descriptor.authority.document.hostInstanceId);
    expect(
      (
        await f.b.database
          .selectFrom("teamPartnerLinks")
          .select("partnerAuthority")
          .executeTakeFirstOrThrow()
      ).partnerAuthority,
    ).toEqual(descriptor.authority);
  } finally {
    await f.close();
  }
});

it("keeps partner proofs and ordinary team/link credentials in separate route families", async () => {
  const f = await pairFixture();
  try {
    const origin = f.a.origin;
    async function refusedSocket(path: string, headers: Record<string, string>) {
      const socket = new WebSocket(new URL(path, origin).toString().replace(/^http/u, "ws"), {
        headers,
      });
      try {
        const status = new Promise<number>((resolve, reject) => {
          socket.once("unexpected-response", (_request, response) => {
            response.destroy();
            resolve(response.statusCode ?? 0);
          });
          socket.once("open", () => reject(new Error("A foreign credential opened the route")));
          socket.on("error", () => {});
        });
        return await withTimeout(status, 3000, {
          timeoutError: () => new Error("Credential separation route never refused"),
        });
      } finally {
        socket.terminate();
      }
    }
    for (const headers of [{ authorization: "Bearer ost_link_foreign" }, f.aSession.headers])
      expect(await refusedSocket(teamPartnerSocketPath, headers)).toBe(403);
    const proof = {
      authorization: "Partner signed-proof-is-not-a-session",
      ...apiVersionHeaders("team"),
    };
    for (const path of ["/v1/realtime", "/internal/v1/team/link"])
      expect(await refusedSocket(path, proof)).toBe(401);
    for (const name of ["team.bootstrap.get", "sessions.list"] as const) {
      const result = await f.a.host.app.inject({
        method: hostApi[name].method,
        url: `/v1/rpc/${name}`,
        headers: proof,
      });
      expect(result.statusCode).toBe(401);
    }
    const binary = await f.a.host.app.inject({
      url: "/v1/team/files/123/original",
      headers: proof,
    });
    expect([401, 403]).toContain(binary.statusCode);
    const mcp = await f.a.host.app.inject({
      method: "POST",
      url: "/mcp",
      headers: proof,
      payload: {},
    });
    expect(mcp.statusCode).toBe(404);
  } finally {
    await f.close();
  }
});

it("allows a freshly verified pairing retry after an incorrect invite verifier", async () => {
  const f = await pairFixture();
  try {
    const offer = parseTeamPartnerOffer(await invite(f.aSession));
    await expect(
      redeem(f.bSession, serializeTeamPartnerOffer({ ...offer, verifier: "A".repeat(43) })),
    ).rejects.toThrow();
    expect(await list(f.bSession)).toMatchObject([{ state: "revoked" }]);
    await expect(redeem(f.bSession, serializeTeamPartnerOffer(offer))).resolves.toMatchObject({
      role: "dialer",
      state: "pending",
    });
  } finally {
    await f.close();
  }
});

it("automatically resumes pairing after the listener commits but its ready response is lost", async () => {
  const f = await pairFixture();
  try {
    await command(f.aSession, { type: "team.sharing.policy.set", policy: "members" });
    const offer = await invite(f.aSession);
    const send = PartnerSocket.prototype.send;
    let dropped = false;
    const fault = vi.spyOn(PartnerSocket.prototype, "send").mockImplementation(function (
      this: PartnerSocket,
      frame: unknown,
    ) {
      if (
        !dropped &&
        typeof frame === "object" &&
        frame !== null &&
        "type" in frame &&
        frame.type === "ready"
      ) {
        dropped = true;
        return Promise.reject(Error("Lost ready response"));
      }
      return send.call(this, frame);
    });
    await expect(redeem(f.bSession, offer)).rejects.toThrow();
    fault.mockRestore();
    expect(dropped).toBe(true);
    await active(f.aSession, f.bSession);
    expect(await list(f.aSession)).toHaveLength(1);
    expect(await list(f.bSession)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
