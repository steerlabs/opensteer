import { describe, expect, it } from "vitest";
import { consentBody } from "./pages.js";

describe("consent page", () => {
  it("lends Opensteer's mark only to Opensteer's own apps", () => {
    const page = (official: boolean) =>
      consentBody({
        account: { displayName: null, email: "owner@example.test" },
        client: { name: "Opensteer", official },
        grants: [{ icon: "person", text: "Your email address" }],
        oauthQuery: "q",
      });
    expect(page(true)).toContain("device--app");
    // A Deployment named "Opensteer" still asks beside a plain server.
    expect(page(false)).not.toContain("device--app");
    expect(page(false)).not.toContain('class="orb');
    expect(page(false)).toContain("Allow Opensteer?");
  });
});
