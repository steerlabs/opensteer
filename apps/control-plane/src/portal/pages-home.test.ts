import { cloudWords, orgWords } from "@opensteer/control-plane-protocol";
import { escapeHtml } from "@opensteer/shared/browserPage";
import { describe, expect, it } from "vitest";
import { portalHomeBody } from "./pages.js";

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
