import { MockHostClient } from "@opensteer/client/mock";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { IntegrationDashboard } from "@opensteer/client/integrations";
import { describe, expect, it } from "vitest";
import { connectedAppsModel } from "./connected-apps-model.js";

describe("connectedAppsModel", () => {
  // The ways it could fail: a repair buried below apps that work; an account
  // named "Tim Jang" twice instead of by the address that tells them apart; an
  // app on a computer, or a revoked account, offered for repair here.
  it("lists each app's accounts by who they are, with the ones needing someone first", async () => {
    const apps = connectedAppsModel({ ...(await read()), hostName: "Tim’s MacBook Pro" });

    expect(apps[0]?.accounts.some(({ status }) => status.tone === "attention")).toBe(true);
    const calendar = apps.find(({ definitionId }) => definitionId === "google-calendar");
    expect(calendar?.accounts.map(({ title }) => title)).toEqual([
      "alex@example.com",
      "alex@opensteer.example",
    ]);
    expect(calendar?.accounts.map(({ repair, status }) => [repair, status.text])).toEqual([
      ["sign-in", "Sign in again to keep using it"],
      ["sign-in", "Sign in again to keep using it"],
    ]);
    expect(calendar?.signIn).toMatchObject({ kind: "direct", source: { kind: "hosted-oauth" } });
    for (const app of apps) {
      for (const account of app.accounts) expect(account.status.text).not.toBe("Revoked");
    }
  });

  // The way it could fail: a phone shown Reconnect for an app whose sign-in
  // returns to the Mac's loopback address, which it can start and never finish.
  it("says where a sign-in this phone cannot finish is finished", async () => {
    const { dashboard, platform } = await read();
    const google = dashboard.providerAuthorizations.google!;
    const loopback = {
      callbackUrl: "http://127.0.0.1:4310/v1/integrations/oauth/callback/google",
      kind: "deployment-oauth" as const,
      providerApplicationId: "ipa_00000000-0000-4000-8000-000000000001" as never,
      providerApplicationRevision: 1,
    };
    const remote: IntegrationDashboard = {
      ...dashboard,
      authorizationSurface: "personal-remote",
      providerAuthorizations: {
        ...dashboard.providerAuthorizations,
        google: {
          ...google,
          availableSources: [loopback],
          code: "CANONICAL_SURFACE_REQUIRED",
          selectedSource: loopback,
          selectedSourceKind: "deployment-oauth",
        },
      },
    };

    const calendar = connectedAppsModel({
      dashboard: remote,
      hostName: "Tim’s MacBook Pro",
      platform,
    }).find(({ definitionId }) => definitionId === "google-calendar");

    expect(calendar?.signIn).toEqual({
      kind: "elsewhere",
      note: "Signing in to Google Calendar here returns to Tim’s MacBook Pro, so connect or reconnect accounts there.",
    });
  });

  it("asks which app to sign in through when the Host selected none", async () => {
    const { dashboard, platform } = await read();
    const github = dashboard.providerAuthorizations.github!;
    const apps = connectedAppsModel({
      dashboard: {
        ...dashboard,
        providerAuthorizations: {
          ...dashboard.providerAuthorizations,
          github: {
            ...github,
            code: "PROVIDER_APPLICATION_REQUIRED",
            selectedSource: null,
            selectedSourceKind: null,
          },
        },
      },
      hostName: "Tim’s MacBook Pro",
      platform,
    });

    const signIn = apps.find(({ definitionId }) => definitionId === "github")?.signIn;
    expect(signIn?.kind).toBe("choose");
    expect(signIn?.kind === "choose" ? signIn.options.map(({ label }) => label) : []).toContain(
      "Opensteer",
    );
  });
});

async function read() {
  const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
  const [dashboard, platform] = await Promise.all([
    client.rpc["integrations.get"]({}).then(unwrapRpcResult),
    client.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
  ]);
  return { dashboard, platform };
}
