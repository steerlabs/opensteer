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
  const { appFrameContentSecurityPolicy, isAppPrefixNavigation } = await import("./appFrame.js");
  expect(appFrameContentSecurityPolicy).toContain("connect-src 'self'");
  expect(appFrameContentSecurityPolicy).toContain("script-src 'self' 'unsafe-inline' https:");
  expect(appFrameContentSecurityPolicy).not.toContain("allow-same-origin");
  const prefix = "https://host/v1/apps/app_test/dark/token/";
  expect(isAppPrefixNavigation(prefix + "settings", prefix)).toBe(true);
  expect(isAppPrefixNavigation(prefix + "#details", prefix)).toBe(true);
  expect(isAppPrefixNavigation("https://host/v1/rpc/foo", prefix)).toBe(false);
  expect(isAppPrefixNavigation("https://other/v1/apps/app_test/dark/token/", prefix)).toBe(false);
});
