import { describe, expect, it, vi } from "vitest";
import type { PersonalAccountLinkStatus } from "@opensteer/protocol";
import { HomeAccountLinkClient, homeAccountLinkView } from "./home-account-link.js";

const authorityEnvelope = { document: {}, publicKey: {}, signature: "s" } as never;
const link = (state: "activating" | "active") =>
  ({
    generation: "g".repeat(43),
    issuer: "https://accounts.example.test",
    state,
    subject: "acct_0192f4a1-1111-4000-8000-000000000001",
  }) as NonNullable<PersonalAccountLinkStatus["accountLink"]>;

function fixture(initial: PersonalAccountLinkStatus, refuse?: string) {
  let status = initial;
  const dispatched: string[] = [];
  const host = {
    dispatch: vi.fn(async (command: { readonly type: string }) => {
      dispatched.push(command.type);
      if (refuse) throw new Error(refuse);
      if (command.type === "personal.accountLink.unlink") status = { ...status, accountLink: null };
      return { type: command.type } as never;
    }),
    rpc: {
      "personal.accountLink.get": async () => ({ ok: true as const, data: status }),
    },
    subscribePersonalRemoteAccess: () => () => undefined,
  };
  const client = new HomeAccountLinkClient(host as never);
  return {
    client,
    dispatched,
    set: (next: PersonalAccountLinkStatus) => {
      status = next;
    },
  };
}

const unlinked: PersonalAccountLinkStatus = {
  accountIssuer: "https://accounts.example.test",
  accountLink: null,
  authorityEnvelope,
  managed: false,
};

describe("a Home's Account link, without Remote access", () => {
  it("links through the app's courier with the Home's own authority, then reads it linked", async () => {
    const { client, set } = fixture(unlinked);
    await client.refresh();
    expect(homeAccountLinkView(client.getSnapshot()).action).toMatchObject({ id: "link" });
    const courier = vi.fn(async () => set({ ...unlinked, accountLink: link("active") }));
    await client.link(courier);
    expect(courier).toHaveBeenCalledWith(authorityEnvelope);
    const view = homeAccountLinkView(client.getSnapshot());
    expect(view.title).toBe("Linked to your Opensteer account");
    expect(view.action).toMatchObject({
      id: "unlink",
      confirm: expect.stringContaining("signed out"),
    });
  });

  it("finishes a link the Home already holds instead of starting another", async () => {
    const { client, dispatched } = fixture({ ...unlinked, accountLink: link("activating") });
    await client.refresh();
    const courier = vi.fn(async () => undefined);
    await client.link(courier);
    expect(courier).not.toHaveBeenCalled();
    expect(dispatched).toEqual(["personal.accountLink.resume"]);
  });

  it("unlinks, and says why when it can't", async () => {
    const { client, dispatched } = fixture({ ...unlinked, accountLink: link("active") });
    await client.refresh();
    await client.unlink();
    expect(dispatched).toEqual(["personal.accountLink.unlink"]);
    expect(client.getSnapshot().status?.accountLink).toBeNull();

    const refused = fixture(
      { ...unlinked, accountLink: link("active") },
      "A Cloud Computer stays linked to the Opensteer account that owns it.",
    );
    await refused.client.refresh();
    await refused.client.unlink();
    expect(refused.client.getSnapshot()).toMatchObject({
      actionError: "A Cloud Computer stays linked to the Opensteer account that owns it.",
      working: false,
    });
  });

  it("offers no unlink on a Cloud Computer, which stays linked to its owner", async () => {
    const { client } = fixture({ ...unlinked, accountLink: link("active"), managed: true });
    await client.refresh();
    expect(homeAccountLinkView(client.getSnapshot()).action).toBeNull();
  });
});
