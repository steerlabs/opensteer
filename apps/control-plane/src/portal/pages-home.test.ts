import { cloudWords, orgWords } from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { describe, expect, it } from "vitest";
import { accountDeletionPendingBody, deleteAccountBody, portalHomeBody } from "./pages.js";

const base = {
  account: { displayName: "Sam", email: "sam@example.com" },
  deleteAccountHref: "/account/delete",
  desktopDownloadUrl: "https://example.com/download",
  hostedTeams: null,
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

  it("says before confirming that a Cloud Computer goes with it, cancelled first, unrefunded", () => {
    const body = deleteAccountBody({ ...base, cloudComputer: true });
    for (const words of [
      "Your Cloud Computer is deleted with it.",
      "Opensteer cancels its subscription first, so it won’t renew",
      "the rest of the period already paid isn’t refunded",
      "If Stripe takes any payment after you confirm, Opensteer refunds it in full.",
      "destroys the computer and its disk",
      "makes its backups unreadable and removes them, and deletes the card saved with Stripe",
      "Your account goes once all of this is done.",
    ])
      expect(body).toContain(escapeHtml(words));
    expect(body).toContain('<form method="post"');
    // Never the promise the code can't keep when Stripe charges during an outage.
    expect(body).not.toContain("nothing more is charged");
  });

  it("keeps an Account whose work Home its organization hasn't offboarded, with no Delete", () => {
    const body = deleteAccountBody({ ...base, workHomes: ["Acme"] });
    expect(body).toContain(
      escapeHtml("Ask your organization admin to offboard your work Cloud Computer first"),
    );
    expect(body).toContain("Acme");
    expect(body).not.toContain("<form");
  });

  it("says a deletion that waits on its Cloud Computer is under way, and whether billing stopped", () => {
    expect(accountDeletionPendingBody({ billingCanceled: true })).toContain(
      escapeHtml("subscription is cancelled, so it won’t renew"),
    );
    expect(accountDeletionPendingBody({ billingCanceled: true })).toContain(
      escapeHtml("Any payment Stripe takes after you asked is refunded in full"),
    );
    expect(accountDeletionPendingBody({ billingCanceled: true })).not.toContain(
      "longer than it should",
    );
    const late = accountDeletionPendingBody({ billingCanceled: true, overdue: true });
    expect(late).toContain(escapeHtml("This is taking longer than it should."));
    expect(late).toContain("tim@opensteer.com");
    expect(accountDeletionPendingBody({ billingCanceled: false })).toContain(
      escapeHtml("keeps trying until Stripe confirms it"),
    );
    // Without a Cloud Computer the page says nothing about one.
    expect(deleteAccountBody(base)).not.toContain("Cloud Computer");
  });
});
