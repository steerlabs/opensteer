import type { NativeOAuthIdentity } from "@opensteer/client/auth";
import {
  createId,
  opensteerMobileAccountOAuthCallback,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  authorizationRedirectOf,
  createAuthorizationBrowser,
  createIntegrationAuthorizationBrowser,
  type AuthorizationSessionOpener,
} from "./authorization-browser.js";

const oauth: NativeOAuthIdentity = {
  accountCallback: opensteerMobileAccountOAuthCallback,
  application: "mobile",
  clientId: opensteerMobileOAuthClientId,
  hostCallback: opensteerMobileHostOAuthCallback,
};

const authorizeUrl = (redirect: string): string =>
  `https://account.example.com/oauth2/authorize?client_id=opensteer-mobile&redirect_uri=${encodeURIComponent(redirect)}&state=abc`;

class FakeBrowser implements AuthorizationSessionOpener {
  result: { readonly type: string; readonly url?: string } = { type: "dismiss" };
  opened: {
    readonly options: { readonly preferEphemeralSession: boolean };
    readonly redirect: string;
    readonly url: string;
  }[] = [];

  async openAuthSessionAsync(
    url: string,
    redirectUrl: string,
    options: { readonly preferEphemeralSession: boolean },
  ) {
    this.opened.push({ options, redirect: redirectUrl, url });
    return this.result;
  }
}

describe("authorizationRedirectOf", () => {
  it("reads the registered Account callback out of the authorize URL", () => {
    expect(authorizationRedirectOf(authorizeUrl(oauth.accountCallback), oauth)).toBe(
      oauth.accountCallback,
    );
  });

  it("refuses a redirect this build does not own", () => {
    expect(() => authorizationRedirectOf(authorizeUrl("com.attacker.app:/steal"), oauth)).toThrow(
      /does not return to Opensteer/u,
    );
  });

  it("refuses an authorize address that is not a web address", () => {
    expect(() =>
      authorizationRedirectOf("com.opensteer.mobile:/oauth/account-callback", oauth),
    ).toThrow(/served over HTTP/u);
    expect(() => authorizationRedirectOf("not a url", oauth)).toThrow(/not a URL/u);
  });
});

describe("createIntegrationAuthorizationBrowser", () => {
  it("watches the fixed native integration callback and returns only its identifiers", async () => {
    const browser = new FakeBrowser();
    const deploymentId = createId("deployment");
    const attemptId = "ioa_00000000-0000-4000-8000-000000000002";
    browser.result = {
      type: "success",
      url: `com.opensteer.mobile:/oauth/integration-callback?deployment_id=${deploymentId}&attempt_id=${attemptId}`,
    };
    const open = createIntegrationAuthorizationBrowser({ browser });
    await expect(open("https://host.example/v1/integration-authorizations/launch")).resolves.toBe(
      browser.result.url,
    );
    expect(browser.opened[0]).toMatchObject({
      redirect: "com.opensteer.mobile:/oauth/integration-callback",
      options: { preferEphemeralSession: false },
    });
  });

  it("does not treat browser closure or a foreign return as completion", async () => {
    const browser = new FakeBrowser();
    const open = createIntegrationAuthorizationBrowser({ browser });
    await expect(open("https://host.example/launch")).rejects.toThrow(/cancelled/u);
    browser.result = { type: "success", url: oauth.accountCallback };
    await expect(open("https://host.example/launch")).rejects.toThrow(/integration attempt/u);
  });
});

describe("createAuthorizationBrowser", () => {
  it("keeps sign-in pending until the callback is processed", async () => {
    const browser = new FakeBrowser();
    browser.result = { type: "success", url: `${oauth.accountCallback}?code=abc&state=abc` };
    let finishDelivery: () => void = () => undefined;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const openExternal = createAuthorizationBrowser({
      broker: { accept: () => true, settled: () => delivery },
      browser,
      oauth,
    });
    let completed = false;
    const signingIn = openExternal(authorizeUrl(oauth.accountCallback)).then(() => {
      completed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    finishDelivery();
    await signingIn;
    expect(completed).toBe(true);
  });

  it("rejects a successful browser result that the callback broker refuses", async () => {
    const browser = new FakeBrowser();
    browser.result = { type: "success", url: "com.attacker.app:/callback" };
    const openExternal = createAuthorizationBrowser({
      broker: { accept: () => false, settled: async () => undefined },
      browser,
      oauth,
    });
    await expect(openExternal(authorizeUrl(oauth.accountCallback))).rejects.toThrow(
      "The authorization browser did not return an Opensteer callback.",
    );
  });

  it("clears the pending flow when the person closes the browser", async () => {
    const accepted: string[] = [];
    const browser = new FakeBrowser();
    browser.result = { type: "cancel" };
    const openExternal = createAuthorizationBrowser({
      broker: {
        settled: async () => undefined,
        accept: (url) => {
          accepted.push(url);
          return true;
        },
      },
      browser,
      oauth,
    });

    await expect(openExternal(authorizeUrl(oauth.hostCallback))).rejects.toThrow(
      "Sign-in was cancelled.",
    );

    expect(accepted).toEqual([]);
  });

  it("never opens a browser for an authorize address with a foreign redirect", async () => {
    const browser = new FakeBrowser();
    const openExternal = createAuthorizationBrowser({
      broker: { accept: () => true, settled: async () => undefined },
      browser,
      oauth,
    });

    await expect(openExternal(authorizeUrl("com.attacker.app:/steal"))).rejects.toThrow(
      /does not return to Opensteer/u,
    );
    expect(browser.opened).toEqual([]);
  });
});
