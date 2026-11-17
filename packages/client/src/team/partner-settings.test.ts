import { afterEach, expect, it, vi } from "vitest";
import { OpensteerError } from "@opensteer/core";
import { parseTeamPartnerOffer, serializeTeamPartnerOffer } from "@opensteer/protocol";
import { MockTeamHost } from "./mock-team-host.js";
import { createMemoryTeamPersistence } from "./persistence.js";
import { partnerLinkStatus, teamPartnerSettings } from "./partner-settings.js";
import { teamRpcResult } from "./rpc-result.js";
import { TeamSessionClient } from "./team-session-client.js";

const clients: TeamSessionClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});
function fixture() {
  const host = new MockTeamHost();
  const client = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    persistence: createMemoryTeamPersistence(),
    rpc: host.rpc,
    connect: host.connect,
  });
  clients.push(client);
  return { host, client, model: teamPartnerSettings(client) };
}
async function offer(host: MockTeamHost) {
  const result = teamRpcResult(
    await host.rpc["commands.dispatch"]({ type: "team.partner.invite.create" }),
  );
  if (result.type !== "team.partner.invite.create") throw new Error("Invite was not created");
  return result.offer;
}

it("loads only when opened and keeps cached state when a refresh fails", async () => {
  const { host, client, model } = fixture();
  expect(host.calls).toEqual([]);
  await model.refresh();
  const policy = model.getSnapshot().policy;
  expect(policy).toMatchObject({ canSet: true, canPropose: true, policy: "admins" });
  expect(teamPartnerSettings(client)).toBe(model);
  vi.spyOn(host, "read").mockRejectedValue(new Error("offline"));
  await model.refresh();
  expect(model.getSnapshot().policy).toBe(policy);
  expect(model.getSnapshot().error).not.toBeNull();
  expect(model.links.getState().first).not.toBeNull();
});

it("requires a reviewed invite, drops a preview after editing, and redeems the exact reviewed link", async () => {
  const { host, model } = fixture();
  const first = await offer(host);
  const second = await offer(host);
  await model.redeemInvite();
  expect(host.partners.size).toBe(0);
  const read = host.read.bind(host);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const preview = vi.spyOn(host, "read").mockImplementation(async (name, input) => {
    if (name === "team.partner.invite.preview") {
      await held;
      return {
        name: "Verified team name",
        origin: parseTeamPartnerOffer(first).origin,
        expiresAt: parseTeamPartnerOffer(first).expiresAt,
      };
    }
    return read(name, input);
  });
  model.setOfferText(first);
  const checking = model.previewInvite();
  model.setOfferText(second);
  finish();
  await checking;
  expect(model.getSnapshot().preview).toBeNull();
  await model.previewInvite();
  expect(model.getSnapshot().preview).toMatchObject({ name: "Verified team name", offer: second });
  await model.redeemInvite();
  expect(host.partners.size).toBe(1);
  expect(model.getSnapshot().preview).toBeNull();
  expect(model.getSnapshot().offerText).toBe("");
  expect(
    preview.mock.calls.filter(
      ([name, input]) =>
        name === "commands.dispatch" &&
        (input as { type: string }).type === "team.partner.invite.redeem",
    ),
  ).toEqual([["commands.dispatch", { type: "team.partner.invite.redeem", offer: second }]]);
});

it("keeps independent actions available, deduplicates taps and clears invite secrets on session retirement", async () => {
  const { host, client, model } = fixture();
  const read = host.read.bind(host);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(host, "read").mockImplementation(async (name, input) => {
    if (
      name === "commands.dispatch" &&
      (input as { type: string }).type === "team.partner.invite.create"
    )
      await held;
    return read(name, input);
  });
  const creating = model.createInvite();
  expect(model.getSnapshot().pending).toEqual(new Set(["create"]));
  expect(await model.createInvite()).toBe(false);
  expect(
    await model.command("policy", { type: "team.sharing.policy.set", policy: "members" }),
  ).toBe(true);
  finish();
  await creating;
  expect(host.partnerInvites.size).toBe(1);
  expect(model.getSnapshot().created?.invite.canRevoke).toBe(true);
  model.setOfferText(model.getSnapshot().created!.offer);
  client.dispose();
  expect(model.getSnapshot()).toMatchObject({
    created: null,
    preview: null,
    offerText: "",
    policy: null,
  });
});

it("reads current Host permissions after policy changes and retains disconnected teams", async () => {
  const { host, model } = fixture();
  const linkOffer = await offer(host);
  host.bootstrap.member.role = "member";
  await model.refresh();
  expect(model.getSnapshot().policy).toMatchObject({ canSet: false, canPropose: false });
  host.sharingPolicy = "members-propose";
  await model.refresh();
  expect(model.getSnapshot().policy?.canPropose).toBe(true);
  model.setOfferText(linkOffer);
  await model.previewInvite();
  await model.redeemInvite();
  const link = model.links.getState().items[0]!;
  expect(link).toMatchObject({ canApprove: false, canRevoke: true });
  expect(partnerLinkStatus(link)).toBe("Waiting for your approval");
  host.sharingPolicy = "members";
  await model.refresh();
  expect(model.links.getState().items[0]?.canApprove).toBe(true);
  await model.command(link.id, { type: "team.partner.revoke", linkId: link.id });
  expect(partnerLinkStatus(model.links.getState().items[0]!)).toBe("Disconnected");
});

it("never confirms an expired invite or publishes a preview after the viewer changes", async () => {
  const { host, client, model } = fixture();
  const valid = await offer(host);
  const expired = serializeTeamPartnerOffer({
    ...parseTeamPartnerOffer(valid),
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  model.setOfferText(expired);
  await model.previewInvite();
  expect(model.getSnapshot().preview).toBeNull();
  expect(model.getSnapshot().errors.preview).not.toBeNull();
  const read = host.read.bind(host);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(host, "read").mockImplementation(async (name, input) => {
    if (name === "team.partner.invite.preview") await held;
    return read(name, input);
  });
  model.setOfferText(valid);
  const checking = model.previewInvite();
  client.dispose();
  finish();
  await checking;
  expect(model.getSnapshot()).toMatchObject({ preview: null, offerText: "" });
});

it("ignores a failed preview for a link that was replaced while checking", async () => {
  const { host, model } = fixture();
  const link = await offer(host);
  const read = host.read.bind(host);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(host, "read").mockImplementation(async (name, input) => {
    if (name === "team.partner.invite.preview") {
      await held;
      throw new OpensteerError({
        code: "forbidden",
        reason: "identity-mismatch",
        message: "Refused",
      });
    }
    return read(name, input);
  });
  model.setOfferText(link);
  const checking = model.previewInvite();
  model.setOfferText("");
  finish();
  await checking;
  expect(model.getSnapshot().errors.preview).toBeNull();
});

it("does not hide another page of partner invites and only returns the viewer’s revocable invites", async () => {
  const { host, model } = fixture();
  const made = parseTeamPartnerOffer(await offer(host));
  const row = host.partnerInvites.get(made.selector)!;
  for (let i = 1; i <= 51; i++)
    host.partnerInvites.set(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
      ...row,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    });
  await model.refresh();
  expect(model.invites.getState().items).toHaveLength(50);
  expect(model.invites.getState().nextCursor).not.toBeNull();
  await model.invites.more();
  expect(model.invites.getState().items).toHaveLength(52);
  host.bootstrap.member.role = "member";
  row.createdBy = "usr_00000000-0000-4000-8000-000000000999" as typeof row.createdBy;
  await model.refresh();
  expect(model.invites.getState().items.some((invite) => invite.id === row.id)).toBe(false);
  expect(model.invites.getState().items.every((invite) => invite.canRevoke)).toBe(true);
  host.sharingPolicy = "off";
  await expect(
    host.read("team.partner.invite.preview", { offer: serializeTeamPartnerOffer(made) }),
  ).rejects.toBeInstanceOf(OpensteerError);
});
