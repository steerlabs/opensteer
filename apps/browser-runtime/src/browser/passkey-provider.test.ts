import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";
import {
  PasskeyProviderTestAuthenticator,
  passkeyProviderChromiumArguments,
  runPasskeyProviderScenario,
  runPasskeyCertificateErrorScenario,
} from "@opensteer/browser-runtime-core/test-support/passkey-provider";

it("serves WebAuthn through the page provider", async () => {
  const authenticator = new PasskeyProviderTestAuthenticator();
  const report = await runPasskeyProviderScenario({
    authenticator,
    launcher: new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath: chromium.executablePath(),
      headless: true,
      authenticator,
      args: passkeyProviderChromiumArguments,
    }),
  });
  expect(report).toMatchObject({
    verifiedPopupRegistrations: 4,
    verifiedPopupAssertions: 4,
    cases: {
      "popup-first-navigated-document": {
        outcome: "resolved",
      },
    },
  });
}, 60_000);

it("refuses a raw binding after proceeding through a certificate interstitial", async () => {
  const authenticator = new PasskeyProviderTestAuthenticator();
  await runPasskeyCertificateErrorScenario({
    authenticator,
    launcher: new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath: chromium.executablePath(),
      headless: true,
      authenticator,
      args: passkeyProviderChromiumArguments,
    }),
  });
}, 30_000);

it("keeps an executable override to Headless Shell absent after one startup probe", async () => {
  const seed = await chromium.launchServer({ headless: true });
  const executablePath = seed.process().spawnfile;
  await seed.kill();
  const authenticator = new PasskeyProviderTestAuthenticator();
  const launcher = new PlaywrightChromiumLauncher({
    authenticator,
    executablePath,
    headless: true,
    chromiumSandbox: false,
  });
  const { validClaims } = await import("@opensteer/browser-runtime-core/test-support");
  const claims = validClaims();
  await launcher.prepare();
  await launcher.prepare();
  expect(launcher.passkeys).toBeUndefined();
  const site = createServer((_request, response) =>
    response.end("<!doctype html><title>Absent provider</title>"),
  );
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  let browser;
  try {
    browser = await launcher.launch({
      sessionId: claims.sessionId,
      partitionKey: `session:${claims.sessionId}`,
      initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
      snapshot: { cookies: [], origins: [] },
    });
    const cdp = await browser.context.pages()[0]!.cdp();
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    await vi.waitFor(async () =>
      expect(
        (
          await cdp.send<{ result: { value: unknown } }>("Runtime.evaluate", {
            expression: "typeof navigator.credentials",
            returnByValue: true,
          })
        ).result.value,
      ).toBe("object"),
    );
    const started = Date.now();
    const result = await cdp.send<{ result: { value: unknown } }>("Runtime.evaluate", {
      expression:
        "(async()=>({provider:typeof PublicKeyCredential,error:await navigator.credentials.get({publicKey:{challenge:new Uint8Array([1])}}).then(()=>null,e=>e.name)}))()",
      awaitPromise: true,
      returnByValue: true,
    });
    expect(result.result.value).toEqual({ provider: "undefined", error: "NotAllowedError" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(authenticator.calls).toBe(0);
  } finally {
    await browser?.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
}, 20_000);
