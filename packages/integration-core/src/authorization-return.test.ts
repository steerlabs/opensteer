import { describe, expect, it } from "vitest";
import { integrationAuthorizationBrowserReturn } from "./authorization-return.js";

const attemptId = "ioa_00000000-0000-4000-8000-000000000001";
const deploymentId = "dep_00000000-0000-4000-8000-000000000001";

describe("integrationAuthorizationBrowserReturn", () => {
  it("keeps desktop completion on the callback page", () => {
    expect(
      integrationAuthorizationBrowserReturn({
        attemptId,
        canonicalOrigin: "https://host.example.test",
        returnPath: "/integrations",
        surface: "desktop",
      }),
    ).toEqual({ kind: "completion-page" });
  });

  it("uses the fixed native callback with only Deployment and attempt ids", () => {
    expect(
      integrationAuthorizationBrowserReturn({
        attemptId,
        canonicalOrigin: "https://host.example.test",
        deploymentId,
        returnPath: "https://attacker.test/ignored",
        surface: "native",
      }),
    ).toEqual({
      kind: "redirect",
      location: `com.opensteer.mobile:/oauth/integration-callback?deployment_id=${deploymentId}&attempt_id=${attemptId}`,
    });
  });

  it("returns web to the stored canonical path and replaces a stale attempt query", () => {
    expect(
      integrationAuthorizationBrowserReturn({
        attemptId,
        canonicalOrigin: "https://host.example.test",
        returnPath: "/settings/integrations?view=accounts&integrationAttempt=stale",
        surface: "web",
      }),
    ).toEqual({
      kind: "redirect",
      location: `https://host.example.test/settings/integrations?view=accounts&integrationAttempt=${attemptId}`,
    });
  });

  it("keeps web completion on the callback page when the attempt has no return destination", () => {
    expect(
      integrationAuthorizationBrowserReturn({
        attemptId,
        canonicalOrigin: "https://host.example.test",
        surface: "web",
      }),
    ).toEqual({ kind: "completion-page" });
  });

  it.each([
    "https://attacker.test/integrations",
    "//attacker.test/integrations",
    "/\\attacker.test/integrations",
    "/integrations#hidden",
    "integrations",
    "",
  ])("rejects an unsafe web return path: %s", (returnPath) => {
    expect(() =>
      integrationAuthorizationBrowserReturn({
        attemptId,
        canonicalOrigin: "https://host.example.test",
        returnPath,
        surface: "web",
      }),
    ).toThrow();
  });

  it.each([
    "javascript:alert(1)",
    "https://user:secret@host.example.test",
    "https://host.example.test/path",
    "https://host.example.test?next=1",
    "https://host.example.test#fragment",
  ])("rejects an invalid canonical origin: %s", (canonicalOrigin) => {
    expect(() =>
      integrationAuthorizationBrowserReturn({
        attemptId,
        canonicalOrigin,
        returnPath: "/integrations",
        surface: "web",
      }),
    ).toThrow();
  });

  it("requires a Deployment identity for native completion", () => {
    expect(() =>
      integrationAuthorizationBrowserReturn({
        attemptId,
        canonicalOrigin: "https://host.example.test",
        surface: "native",
      }),
    ).toThrow("Deployment identity");
  });
});
