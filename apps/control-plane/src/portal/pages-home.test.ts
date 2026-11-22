import { cloudWords, orgWords } from "@opensteer/control-plane-protocol";
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
  it("offers a Cloud Computer and organizations to someone with no Opensteer yet, and with one", () => {
    for (const rows of [[], ['<li class="place">Studio</li>']]) {
      const body = portalHomeBody({
        ...base,
        rows,
        cloudComputerHref: "/cloud-computer",
        organizationsHref: "/organizations",
      });
      expect(body).toContain(`href="/cloud-computer">${escapeHtml(cloudWords("cloud.title"))}</a>`);
      expect(body).toContain(`href="/organizations">${escapeHtml(orgWords("org.title"))}</a>`);
    }
  });

  it("offers neither where this Account service has neither", () => {
    const body = portalHomeBody({ ...base, rows: [] });
    expect(body).not.toContain('href="/cloud-computer"');
    expect(body).not.toContain('href="/organizations"');
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

  it("keeps an Account whose work Home its organization hasn't offboarded, with no Delete", () => {
    const body = deleteAccountBody({ ...base, workHomes: ["Acme"] });
    expect(body).toContain(
      escapeHtml("Ask your organization admin to offboard your work Cloud Computer first"),
    );
    expect(body).toContain("Acme");
    expect(body).not.toContain("<form");
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
