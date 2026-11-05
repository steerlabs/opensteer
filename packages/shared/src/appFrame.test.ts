import { expect, it } from "vitest";
import { appContentHeight, appThemeScript, prepareAppHtml } from "./appFrame.js";
it("injects the size and theme bridge before an app's scripts while preserving its doctype", () => {
  const html =
    '<!doctype html><html><head><script src="https://cdn.test/chart.js"></script></head><body></body></html>';
  for (const theme of ["light", "dark"] as const) {
    const document = prepareAppHtml(html, theme);
    expect(document.startsWith("<!doctype html>")).toBe(true);
    expect(document.indexOf("opensteer-app:size")).toBeLessThan(
      document.indexOf("https://cdn.test"),
    );
    expect(document).toContain(appThemeScript(theme));
    expect(document).toContain("ResizeObserver");
    expect(document).toContain("ReactNativeWebView.postMessage");
    expect(document).toContain("e.source!==parent");
  }
});
it("bounds hostile or very tall height reports while ignoring unrelated messages", () => {
  expect(appContentHeight({ type: "opensteer-app:size", height: 12_345.2 })).toBe(12_346);
  expect(appContentHeight({ type: "opensteer-app:size", height: 1e9 })).toBe(100_000);
  for (const height of [-1, 0, NaN, Infinity, "500"])
    expect(appContentHeight({ type: "opensteer-app:size", height })).toBeNull();
  expect(appContentHeight({ type: "navigate", height: 500 })).toBeNull();
});

it.each(["<title>Chart</title><body>Hi", "<body>Hi"])(
  "normalizes HTML fragments into standards-mode documents: %s",
  (html) => {
    expect(prepareAppHtml(html, "dark")).toMatch(/^<!doctype html>/u);
  },
);

it("permits relative app resources and same-prefix navigation without granting a same origin", async () => {
  const { appFrameContentSecurityPolicy, isAppNavigation } = await import("./appFrame.js");
  expect(appFrameContentSecurityPolicy).toContain("connect-src 'self'");
  expect(appFrameContentSecurityPolicy).toContain("script-src 'self' 'unsafe-inline' https:");
  expect(appFrameContentSecurityPolicy).not.toContain("allow-same-origin");
  const prefix = "https://host/v1/apps/app_test/dark/token/";
  expect(isAppNavigation(prefix + "settings", prefix)).toBe(true);
  expect(isAppNavigation(prefix + "#details", prefix)).toBe(true);
  expect(isAppNavigation("https://host/v1/rpc/foo", prefix)).toBe(false);
  expect(isAppNavigation("https://other/v1/apps/app_test/dark/token/", prefix)).toBe(false);
});

it("maps every app to exactly one origin label and rejects other spellings", async () => {
  const { appIdFromHostname, appOriginKey, isAppOriginUrl } = await import("./appFrame.js");
  const appId = "app_0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0ff";
  const key = appOriginKey(appId);
  expect(key).toMatch(/^[a-z2-7]{26}$/u);
  const deployment = "0123456789abcdef0123456789abcdef";
  expect(appIdFromHostname(`${key}-${deployment}.opensteerapp.com`)).toBe(appId);
  expect(appIdFromHostname(`${key}.localhost`)).toBe(appId);
  // The last base32 character carries two unused bits, which must not create a second origin.
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const alias = key.slice(0, -1) + alphabet[alphabet.indexOf(key.at(-1)!) ^ 1];
  expect(appIdFromHostname(`${alias}.localhost`)).toBeNull();
  expect(appIdFromHostname(`connect-${deployment}.opensteerapp.com`)).toBeNull();
  expect(isAppOriginUrl(`https://${key}-${deployment}.opensteerapp.com/?opensteer-ticket=x`)).toBe(
    true,
  );
  expect(isAppOriginUrl(`http://${key}.localhost:4310/`)).toBe(true);
  expect(isAppOriginUrl(`http://${key}.example.com/`)).toBe(false);
});

it("keeps same-origin links in a real-origin app and hides the ticket before app code runs", async () => {
  const { isAppNavigation } = await import("./appFrame.js");
  const document = "https://abc.opensteerapp.com/?opensteer-ticket=one-use";
  expect(isAppNavigation("https://abc.opensteerapp.com/settings", document)).toBe(true);
  expect(isAppNavigation("https://other.opensteerapp.com/", document)).toBe(false);
  const html = prepareAppHtml('<head><script src="/app.js"></script></head>', "dark", true);
  expect(html.indexOf("history.replaceState")).toBeLessThan(html.indexOf("/app.js"));
  expect(html.indexOf("'__Host-'+pair")).toBeLessThan(html.indexOf("/app.js"));
  expect(prepareAppHtml("<body>", "dark")).not.toContain("replaceState");
});
