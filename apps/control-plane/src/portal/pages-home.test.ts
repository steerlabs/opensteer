import { cloudWords } from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { describe, expect, it } from "vitest";
import { accountDeletedBody, deleteAccountBody, placeRow, portalHomeBody } from "./pages.js";

const base = {
  account: { displayName: "Sam", email: "sam@example.com" },
  deleteAccountHref: "/account/delete",
  desktopDownloadUrl: "https://example.com/download",
  signOutAction: "/sign-out",
};

describe("the Account portal's home", () => {
  it("offers a Cloud Computer to someone with no Opensteer yet, and with one", () => {
    const empty = portalHomeBody({ ...base, rows: [], cloudComputerHref: "/cloud-computer" });
    expect(empty).toContain(`href="/cloud-computer">On an Opensteer Cloud Computer</a>`);
    const listed = portalHomeBody({
      ...base,
      rows: ['<li class="place">Studio</li>'],
      cloudComputerHref: "/cloud-computer",
    });
    expect(listed).toContain(`href="/cloud-computer">${escapeHtml(cloudWords("cloud.title"))}</a>`);
  });

  it("asks where an account's first Opensteer should live, with the price checkout sells", () => {
    const plan = {
      name: "Cloud Computer",
      currency: "usd",
      amountMinor: 2000,
      interval: "month" as const,
    };
    const body = portalHomeBody({
      ...base,
      rows: [],
      cloudComputerHref: "/cloud-computer",
      cloudOffer: plan,
    });
    expect(body).toContain("Where should your Opensteer live?");
    expect(body).toContain(`href="https://example.com/download">On your Mac</a>`);
    expect(body).toContain("Free. Works while your Mac is awake.");
    expect(body).toContain("$20.00 a month. Always on.");
    expect(body).not.toContain("Set up Opensteer");
    // Nothing for sale: no price, and still what a Cloud Computer is.
    const closed = portalHomeBody({ ...base, rows: [], cloudComputerHref: "/cloud-computer" });
    expect(closed).toContain(`<span class="place__note">Always on.</span>`);
    expect(closed).not.toContain("$");
  });

  it("lists one Opensteer rather than opening it, so the account's own page stays reachable", () => {
    const body = portalHomeBody({ ...base, rows: ['<li class="place">Studio</li>'] });
    expect(body).toContain("Your Opensteers");
    expect(body).toContain("Sign out");
    expect(body).not.toContain("http-equiv");
    expect(body).not.toContain("location.");
  });

  it("offers no Cloud Computer where this Account service has none", () => {
    const body = portalHomeBody({ ...base, rows: [] });
    expect(body).not.toContain('href="/cloud-computer"');
  });
});

describe("the page that deletes an Account", () => {
  const base = {
    action: "/account/delete",
    computers: [],
    email: "sam@example.com",
    failed: false,
    heldTeams: [],
    settingUp: [],
    servers: [],
  };

  it("says before confirming what deleting its Cloud Computer with it promises", () => {
    const body = deleteAccountBody({ ...base, cloudComputer: true });
    for (const words of [
      "Your Cloud Computer is deleted with it.",
      // The same promise as deleting only the Cloud Computer.
      cloudWords("cloud.delete.billing"),
      "Opensteer destroys the computer and its disk",
      "deletes the payment details kept with Stripe for its subscription",
      "Stripe keeps its own records of past payments.",
      "Your account itself is deleted at once.",
    ])
      expect(body).toContain(escapeHtml(words));
    expect(cloudWords("cloud.delete.body")).toContain(cloudWords("cloud.delete.billing"));
    expect(body).toContain('<form method="post"');
    // Never a promise the code doesn't keep: no automatic refund, no order it doesn't enforce.
    expect(body).not.toContain("nothing more is charged");
    expect(body).not.toContain("refunds it in full");
    expect(body).not.toContain("then Opensteer");
  });

  it("says once the Account is deleted that its Cloud Computer's deletion is being finished", () => {
    const body = accountDeletedBody({ cloudComputer: true });
    expect(body).toContain("Your Opensteer account is deleted");
    expect(body).toContain(escapeHtml("Opensteer is finishing your Cloud Computer’s deletion."));
    expect(body).toContain(escapeHtml(cloudWords("cloud.delete.billing")));
    expect(body).toContain(
      escapeHtml("payment details kept with Stripe for its subscription are deleted"),
    );
    // Without a Cloud Computer the pages say nothing about one.
    expect(accountDeletedBody()).not.toContain("Cloud Computer");
    expect(deleteAccountBody(base)).not.toContain("Cloud Computer");
  });
});

describe("a row on Your Opensteers", () => {
  it("says what kind of Home it is in the table's words, a Mac included", () => {
    const row = (kind: "personal" | "cloud" | "server", kindLabel: string) =>
      placeRow({
        control: { kind: "none" },
        id: "dep_1",
        kind,
        kindLabel,
        name: "Studio",
        remove: null,
        status: null,
      });
    expect(row("personal", "Mac")).toContain('<span class="place__note">Mac</span>');
    expect(row("cloud", "Cloud Computer")).toContain(
      '<span class="place__note">Cloud Computer</span>',
    );
    expect(row("server", "Server")).toContain('<span class="place__note">Server</span>');
  });
});
