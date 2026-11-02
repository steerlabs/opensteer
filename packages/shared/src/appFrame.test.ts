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
