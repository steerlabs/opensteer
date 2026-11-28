import { describe, expect, it } from "vitest";
import { accountDeletedBody, accountFrontDoorBody, consentBody, signInBody } from "./pages.js";

it("calls it an Opensteer account on sign-in and deletion pages", () => {
  const linked = signInBody({ hiddenFields: "", reauthorization: false, hostedOAuth: true });
  expect(linked).toContain("Sign in with the Opensteer account linked to that Home.");
  expect(accountFrontDoorBody()).toContain(">Opensteer account</h1>");
  expect(accountDeletedBody()).toContain("Your Opensteer account is deleted");
});

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
