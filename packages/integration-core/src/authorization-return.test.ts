import { describe, expect, it } from "vitest";
import {
  integrationAuthorizationAppReturnBase,
  integrationAuthorizationBrowserReturn,
} from "./authorization-return.js";
import { BeginIntegrationAuthorizationSchema, BeginMcpAuthorizationSchema } from "./models.js";

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

describe("desktop loopback handoff", () => {
  const proof = "P".repeat(43);
  const held = {
    attemptId,
    canonicalOrigin: "https://accounts.example.test",
    deploymentId,
    finish: "app",
    returnProof: proof,
    surface: "desktop",
  } as const;

  it("carries the proof in the form, never in the address it posts to", () => {
    const result = integrationAuthorizationBrowserReturn({ ...held, appReturnPort: 48_200 });
    expect(result).toEqual({
      kind: "open-app",
      location: `${integrationAuthorizationAppReturnBase("desktop")}?deployment_id=${deploymentId}&attempt_id=${attemptId}&return=${proof}`,
      handoff: {
        action: "http://127.0.0.1:48200/oauth/integration-callback",
        fields: { attempt_id: attemptId, deployment_id: deploymentId, return: proof },
      },
    });
  });

  it("offers no handoff without a port or a proof, or to a phone", () => {
    expect(integrationAuthorizationBrowserReturn(held)).not.toHaveProperty("handoff");
    const { returnProof: _none, ...failed } = held;
    expect(
      integrationAuthorizationBrowserReturn({ ...failed, appReturnPort: 48_200 }),
    ).not.toHaveProperty("handoff");
    expect(
      integrationAuthorizationBrowserReturn({ ...held, appReturnPort: 48_200, surface: "native" }),
    ).not.toHaveProperty("handoff");
  });

  it("refuses to address a port outside the reserved block", () => {
    expect(() => integrationAuthorizationBrowserReturn({ ...held, appReturnPort: 3_000 })).toThrow();
  });

  it.each([
    ["provider", BeginIntegrationAuthorizationSchema, { definitionId: "google-gmail" }],
    [
      "MCP",
      BeginMcpAuthorizationSchema,
      {
        displayName: "Linear",
        requestId: `req_${crypto.randomUUID()}`,
        serverId: `isv_${crypto.randomUUID()}`,
      },
    ],
  ] as const)("admits a %s port only for a desktop app finish", (_flow, schema, base) => {
    const begin = { ...base, finish: "app", surface: "desktop" };
    expect(schema.safeParse({ ...begin, appReturnPort: 48_200 }).success).toBe(true);
    expect(schema.safeParse({ ...begin, appReturnPort: 48_215 }).success).toBe(true);
    for (const port of [47_999, 48_199, 48_216, 3_000, 48_200.5, "48200"])
      expect(schema.safeParse({ ...begin, appReturnPort: port }).success).toBe(false);
    expect(schema.safeParse({ ...begin, appReturnPort: 48_200, surface: "native" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...base, appReturnPort: 48_200, surface: "desktop" }).success).toBe(
      false,
    );
  });
});
