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
  for (const kind of ["apps", "plugin-pages"]) {
    const prefix = `https://host/v1/${kind}/app_test/dark/token/`;
    expect(isAppNavigation(prefix + "settings", prefix)).toBe(true);
    expect(isAppNavigation(prefix + "#details", prefix)).toBe(true);
    expect(isAppNavigation("https://host/v1/rpc/foo", prefix)).toBe(false);
    expect(isAppNavigation("https://other/v1/apps/app_test/dark/token/", prefix)).toBe(false);
  }
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

it("names only web pages outside the app as departures, wherever the app is served", async () => {
  const { appDeparture } = await import("./appFrame.js");
  for (const kind of ["apps", "plugin-pages"]) {
    const prefix = `https://host/v1/${kind}/app_test/dark/token/`;
    expect(appDeparture("https://www.linkedin.com/in/someone", prefix)).toBe(
      "https://www.linkedin.com/in/someone",
    );
    expect(appDeparture("http://reddit.com/r/x#top", prefix)).toBe("http://reddit.com/r/x#top");
    // The Host's own other pages are not the app's, so they leave it too.
    expect(appDeparture("https://host/v1/rpc/foo", prefix)).toBe("https://host/v1/rpc/foo");
    for (const stays of [prefix + "settings", "settings", prefix + "#details", "#details"])
      expect(appDeparture(stays, prefix)).toBeNull();
    for (const refused of [
      "mailto:a@b.test",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "opensteer-app://view/",
      "https://user:secret@example.com/",
      `https://example.com/${"a".repeat(8200)}`,
      "not a url at all \u0000",
    ])
      expect(appDeparture(refused, prefix)).toBeNull();
  }
  const real = "https://abc.opensteerapp.com/page";
  expect(appDeparture("https://abc.opensteerapp.com/other", real)).toBeNull();
  expect(appDeparture("https://other.opensteerapp.com/", real)).toBe(
    "https://other.opensteerapp.com/",
  );
});

it("reads a bootstrap's request to open a page only as a web address", async () => {
  const { appLinkRequest } = await import("./appFrame.js");
  expect(appLinkRequest({ url: "https://example.com/a" })).toBe("https://example.com/a");
  for (const hostile of [
    null,
    "https://example.com",
    {},
    { url: 42 },
    { url: "javascript:alert(1)" },
    { url: "app://opensteer/settings" },
    { url: "https://u:p@example.com/" },
    { url: `https://example.com/${"a".repeat(8200)}` },
  ])
    expect(appLinkRequest(hostile)).toBeNull();
});

it("routes an app's departures through its own port, set up before the app's scripts", async () => {
  const { appLinkPortMessage } = await import("./appFrame.js");
  const document = prepareAppHtml(
    "<!doctype html><head><script>window.open('https://x.test')</script></head>",
    "dark",
  );
  expect(document.indexOf("window.open=function")).toBeLessThan(document.indexOf("https://x.test"));
  expect(document.indexOf(appLinkPortMessage)).toBeLessThan(document.indexOf("https://x.test"));
  expect(document.indexOf(appLinkPortMessage)).toBeLessThan(
    document.indexOf("send({type:'opensteer-app:ready'})"),
  );
  // A modifier keeps the browser's own gesture.
  expect(document).toContain("e.metaKey||e.ctrlKey||e.shiftKey||e.altKey");
});

it("runs the bootstrap before anything the app wrote, inside the app's own opening tags", () => {
  const bootstrapAt = (document: string) => document.indexOf('<meta charset="utf-8">');
  const cases: [string, string, string][] = [
    // [html, what must precede the bootstrap, what must follow it]
    [
      '<!-- a template: <head><script>window.first="app"</script> --><html style="--v:1"><head data-x="a>b"><script>window.app=1</script></head></html>',
      '<head data-x="a>b">',
      "window.app=1",
    ],
    [
      '<!doctype html><script>window.first="app"</script><html lang="en"><head></head></html>',
      "<!doctype html>",
      'window.first="app"',
    ],
    [
      '<!doctype html>\n<!-- note -->\n<html lang="en">\n<body><script>window.app=1</script></body></html>',
      '<html lang="en">',
      "window.app=1",
    ],
    ["<p>fragment</p><script>window.app=1</script>", "<!doctype html>", "<p>fragment</p>"],
  ];
  for (const [html, before, after] of cases) {
    const document = prepareAppHtml(html, "dark");
    expect(document.indexOf(before) + before.length).toBeLessThanOrEqual(bootstrapAt(document));
    expect(bootstrapAt(document)).toBeLessThan(document.indexOf(after, bootstrapAt(document) - 1));
    expect(document.lastIndexOf(after)).toBeGreaterThan(bootstrapAt(document));
  }
});
