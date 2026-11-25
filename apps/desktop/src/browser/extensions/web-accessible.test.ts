import { describe, expect, it } from "vitest";
import { mayReachExtensionResource } from "./web-accessible.js";

const id = "abcdefghijklmnopabcdefghijklmnop";
const other = "ponmlkjihgfedcbaponmlkjihgfedcba";
const absent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const web = "https://site.test";
const ext = (path: string, extensionId = id) => `chrome-extension://${extensionId}/${path}`;

const mv3 = {
  manifest_version: 3,
  web_accessible_resources: [
    { resources: ["war.html", "images/*.png", "/lead.js"], matches: ["<all_urls>"] },
    { resources: ["site-only.html"], matches: ["https://*.site.test/*"] },
    { resources: ["port-only.html"], matches: ["http://127.0.0.1:8080/*"] },
    { resources: ["path-pattern.html"], matches: ["https://site.test/app/*"] },
    { resources: ["peer.html"], extension_ids: [other] },
    { resources: ["any-extension.html"], extension_ids: ["*"] },
    { resources: ["dynamic.html"], matches: ["<all_urls>"], use_dynamic_url: true },
    "string-entry.html",
  ],
};
const mv2 = {
  manifest_version: 2,
  web_accessible_resources: ["war.html", "assets/*", { resources: ["object.html"] }],
};

function lookup(manifests: Record<string, unknown>) {
  return (extensionId: string) => manifests[extensionId];
}
const reach = (
  target: string,
  initiator: string | undefined,
  manifest: unknown = mv3,
  options?: { redirect?: boolean; dynamicAlias?: boolean },
) => mayReachExtensionResource(target, initiator, lookup({ [id]: manifest }), options);

describe("mayReachExtensionResource", () => {
  it("lets every address that is not an extension address through untouched", () => {
    expect(reach("https://site.test/", web)).toBe(true);
    expect(reach("about:blank", web)).toBe(true);
  });

  it("admits an MV3 resource listed for the initiator and refuses one that is not listed", () => {
    expect(reach(ext("war.html"), web)).toBe(true);
    expect(reach(ext("images/a.png"), web)).toBe(true);
    expect(reach(ext("images/nested/deep/a.png"), web)).toBe(true);
    expect(reach(ext("lead.js"), web)).toBe(true);
    expect(reach(ext("nonwar.html"), web)).toBe(false);
    expect(reach(ext("images/a.jpg"), web)).toBe(false);
    expect(reach(ext("images.png"), web)).toBe(false);
  });

  it("matches MV3 `matches` against the initiator origin only", () => {
    expect(reach(ext("site-only.html"), "https://site.test")).toBe(true);
    expect(reach(ext("site-only.html"), "https://a.site.test")).toBe(true);
    expect(reach(ext("site-only.html"), "http://site.test")).toBe(false);
    expect(reach(ext("site-only.html"), "https://evil-site.test")).toBe(false);
    expect(reach(ext("port-only.html"), "http://127.0.0.1:8080")).toBe(true);
    expect(reach(ext("port-only.html"), "http://127.0.0.1:9090")).toBe(false);
    // Chrome requires the path /* in `matches`; another path grants nothing here.
    expect(reach(ext("path-pattern.html"), "https://site.test")).toBe(false);
  });

  it("refuses MV3 resources for an unknown, opaque or non-web initiator", () => {
    expect(reach(ext("war.html"), undefined)).toBe(false);
    expect(reach(ext("war.html"), "null")).toBe(false);
    expect(reach(ext("war.html"), "file://")).toBe(false);
    expect(reach(ext("war.html"), "data:")).toBe(false);
  });

  it("admits another extension only through `extension_ids`", () => {
    expect(reach(ext("peer.html"), `chrome-extension://${other}`)).toBe(true);
    expect(reach(ext("peer.html"), `chrome-extension://${absent}`)).toBe(false);
    expect(reach(ext("peer.html"), web)).toBe(false);
    expect(reach(ext("any-extension.html"), `chrome-extension://${absent}`)).toBe(true);
    expect(reach(ext("any-extension.html"), web)).toBe(false);
    // `<all_urls>` covers web origins, never another extension.
    expect(reach(ext("war.html"), `chrome-extension://${other}`)).toBe(false);
  });

  it("grants nothing through `use_dynamic_url` entries or malformed entries", () => {
    expect(reach(ext("dynamic.html"), web)).toBe(false);
    expect(reach(ext("string-entry.html"), web)).toBe(false);
    expect(reach(ext("war.html"), web, { manifest_version: 3 })).toBe(false);
    expect(reach(ext("war.html"), web, { manifest_version: 3, web_accessible_resources: {} })).toBe(
      false,
    );
    expect(reach(ext("war.html"), web, { manifest_version: 4, web_accessible_resources: [] })).toBe(
      false,
    );
  });

  it("admits MV2 string resources for any initiator and ignores MV3-shaped entries", () => {
    expect(reach(ext("war.html"), web, mv2)).toBe(true);
    expect(reach(ext("war.html"), undefined, mv2)).toBe(true);
    expect(reach(ext("war.html"), `chrome-extension://${other}`, mv2)).toBe(true);
    expect(reach(ext("assets/x/y.css"), web, mv2)).toBe(true);
    expect(reach(ext("nonwar.html"), web, mv2)).toBe(false);
    expect(reach(ext("object.html"), web, mv2)).toBe(false);
  });

  it("always lets an extension's own pages reach its own resources", () => {
    expect(reach(ext("nonwar.html"), `chrome-extension://${id}`)).toBe(true);
    expect(reach(ext("nonwar.html"), `chrome-extension://${id}`, null)).toBe(true);
    // A server redirect into an extension comes from the web.
    expect(reach(ext("nonwar.html"), `chrome-extension://${id}`, mv3, { redirect: true })).toBe(
      false,
    );
    expect(reach(ext("war.html"), web, mv3, { redirect: true })).toBe(true);
  });

  it("decides on the path alone: query and fragment do not change the answer", () => {
    expect(reach(ext("war.html?x=1#y"), web)).toBe(true);
    expect(reach(ext("nonwar.html?war.html"), web)).toBe(false);
    expect(reach(ext("nonwar.html#war.html"), web)).toBe(false);
  });

  it("compares the path case-sensitively and the extension id case-insensitively", () => {
    expect(reach(ext("WAR.html"), web)).toBe(false);
    expect(reach(ext("war.html", id.toUpperCase()), web)).toBe(true);
    expect(reach(ext("nonwar.html", id.toUpperCase()), web)).toBe(false);
  });

  it("decodes percent-encoding before matching and refuses traversal", () => {
    expect(reach(ext("w%61r.html"), web)).toBe(true);
    expect(reach(ext("n%6Fnwar.html"), web)).toBe(false);
    expect(reach(ext("images/..%2Fnonwar.html"), web)).toBe(false);
    expect(reach(ext("images%2F..%2Fnonwar.png"), web)).toBe(false);
    expect(reach(ext("images/%2e%2e/nonwar.png"), web)).toBe(false);
    expect(reach(ext("images/../war.html"), web)).toBe(true);
    expect(reach(ext("images/../nonwar.html"), web)).toBe(false);
    expect(reach(ext("images/a.png%00.html"), web)).toBe(false);
    expect(reach(ext("images\\a.png"), web)).toBe(false);
    expect(reach(ext("images/%E0%A4%A.png"), web)).toBe(false);
  });

  it("refuses an extension that is not loaded exactly like a resource that is not listed", () => {
    expect(reach(ext("war.html", absent), web)).toBe(false);
    expect(reach(ext("nonwar.html", absent), web)).toBe(false);
    expect(reach(ext("war.html"), web, null)).toBe(false);
    expect(reach(ext(""), web)).toBe(false);
    expect(reach("chrome-extension://not-an-id/war.html", web)).toBe(false);
    expect(reach(`chrome-extension://${id}:80/war.html`, web)).toBe(false);
    expect(reach("chrome-extension:", web)).toBe(false);
  });
});

describe("mayReachExtensionResource on wrapped and unusual spellings", () => {
  it("reads an address with tabs or leading controls as the extension address it parses to", () => {
    expect(reach(`chrome-ex\ttension://${id}/nonwar.html`, web)).toBe(false);
    expect(reach(`\u0001chrome-extension://${id}/nonwar.html`, web)).toBe(false);
    expect(reach(`CHROME-EXTENSION://${id}/nonwar.html`, web)).toBe(false);
    expect(reach(`chrome-ex\ttension://${id}/war.html`, web)).toBe(true);
  });

  it("lets only the extension's own pages reach its blob:, filesystem: and view-source: addresses", () => {
    for (const wrapped of [
      `blob:chrome-extension://${id}/0b1c`,
      `filesystem:chrome-extension://${id}/temporary/war.html`,
      `view-source:chrome-extension://${id}/war.html`,
      `view-source:blob:chrome-extension://${id}/0b1c`,
    ]) {
      expect(reach(wrapped, web), wrapped).toBe(false);
      expect(reach(wrapped, `chrome-extension://${other}`), wrapped).toBe(false);
      expect(reach(wrapped, `chrome-extension://${id}`), wrapped).toBe(true);
      expect(reach(wrapped, `chrome-extension://${id}`, mv3, { redirect: true }), wrapped).toBe(
        false,
      );
    }
    expect(reach("blob:chrome-extension://not-an-id/0b1c", "chrome-extension://not-an-id")).toBe(
      false,
    );
    expect(reach("blob:https://site.test/0b1c", web)).toBe(true);
    expect(reach("blob:null/0b1c", "null")).toBe(true);
  });
});

describe("MV3 `matches` host and port parsing (S1)", () => {
  const only = (pattern: string) => ({
    manifest_version: 3,
    web_accessible_resources: [{ resources: ["page.html"], matches: [pattern] }],
  });
  const admits = (pattern: string, origin: string) =>
    reach(ext("page.html"), origin, only(pattern));

  it("matches a default port, a port on a subdomain pattern, IPv6 and any port", () => {
    expect(admits("https://site.test:443/*", "https://site.test")).toBe(true);
    expect(admits("https://site.test:443/*", "https://site.test:8443")).toBe(false);
    expect(admits("http://site.test:80/*", "http://site.test")).toBe(true);
    expect(admits("https://*.site.test:8080/*", "https://a.site.test:8080")).toBe(true);
    expect(admits("https://*.site.test:8080/*", "https://a.site.test:9090")).toBe(false);
    expect(admits("http://[::1]:8080/*", "http://[::1]:8080")).toBe(true);
    expect(admits("http://[::1]:8080/*", "http://[::2]:8080")).toBe(false);
    expect(admits("http://[0:0::1]/*", "http://[::1]:9")).toBe(true);
    expect(admits("https://site.test:*/*", "https://site.test:1234")).toBe(true);
    expect(admits("https://site.test/*", "https://site.test:1234")).toBe(true);
    expect(admits("*://*:8080/*", "https://any.test:8080")).toBe(true);
    expect(admits("*://*:8080/*", "https://any.test")).toBe(false);
    expect(admits("HTTPS://SITE.TEST/*", "https://site.test")).toBe(true);
  });

  it("refuses malformed patterns instead of reading them loosely", () => {
    expect(admits("https://site.test:/*", "https://site.test")).toBe(false);
    expect(admits("https://site.test:8080:9999/*", "https://site.test:8080")).toBe(false);
    expect(admits("https://*./*", "https://evil.test.")).toBe(false);
    expect(admits("https://*./*", "https://evil.test")).toBe(false);
    expect(admits("https://site.test:99999/*", "https://site.test:99999")).toBe(false);
    expect(admits("https://site.test:8x/*", "https://site.test")).toBe(false);
    expect(admits("https://[::1/*", "https://[::1]")).toBe(false);
    expect(admits("https://*.[::1]/*", "https://[::1]")).toBe(false);
    expect(admits("https://si*te.test/*", "https://site.test")).toBe(false);
  });
});

describe("a server redirect into an extension (W1)", () => {
  const redirect = (target: string, from: string | undefined, manifest: unknown = mv3) =>
    reach(target, from, manifest, { redirect: true });

  it("judges the origin of the response that redirects against `matches`", () => {
    expect(redirect(ext("war.html"), "https://idp.test")).toBe(true);
    expect(redirect(ext("site-only.html"), "https://a.site.test")).toBe(true);
    expect(redirect(ext("site-only.html"), "https://evil.test")).toBe(false);
    expect(redirect(ext("nonwar.html"), "https://site.test")).toBe(false);
  });

  it("never lets an extension origin, `extension_ids` or an unknown origin admit it", () => {
    expect(redirect(ext("nonwar.html"), `chrome-extension://${id}`)).toBe(false);
    expect(redirect(ext("war.html"), `chrome-extension://${id}`)).toBe(false);
    expect(redirect(ext("peer.html"), `chrome-extension://${other}`)).toBe(false);
    expect(redirect(ext("any-extension.html"), "https://evil.test")).toBe(false);
    expect(redirect(ext("war.html"), undefined)).toBe(false);
    expect(redirect(ext("war.html"), "null")).toBe(false);
    expect(redirect(ext("war.html"), undefined, mv2)).toBe(false);
    expect(redirect(ext("war.html"), "https://evil.test", mv2)).toBe(true);
  });
});

describe("an extension's dynamic host (use_dynamic_url, S2)", () => {
  const dynamic = "chrome-extension://e7c508fa-1f5c-471b-9065-5bf03292faaa";

  it("lets an address at a dynamic host through for every initiator: Chromium enforces it", () => {
    for (const initiator of [web, `chrome-extension://${id}`, "null", undefined])
      for (const path of ["dyn.html", "nonwar.html", "war.html"])
        expect(reach(`${dynamic}/${path}`, initiator), `${path} from ${initiator}`).toBe(true);
    expect(reach(`${dynamic}/dyn.html`, "https://evil.test", mv3, { redirect: true })).toBe(true);
    expect(reach(`${dynamic.toUpperCase()}/dyn.html`, web)).toBe(true);
  });

  it("still refuses a host that is neither an extension id nor a dynamic host", () => {
    expect(reach("chrome-extension://e7c508fa-1f5c-471b-9065/dyn.html", web)).toBe(false);
    expect(reach("chrome-extension://e7c508fa1f5c471b90655bf03292faaa/dyn.html", web)).toBe(false);
    expect(reach(`${dynamic}:80/dyn.html`, web)).toBe(false);
    expect(reach(`blob:${dynamic}/0b1c`, web)).toBe(false);
  });

  it("grants nothing at the static address through a use_dynamic_url entry", () => {
    expect(reach(ext("dynamic.html"), web)).toBe(false);
  });
});

describe("MV3 `matches` hosts parsed strictly (R4)", () => {
  const only = (pattern: string) => ({
    manifest_version: 3,
    web_accessible_resources: [{ resources: ["page.html"], matches: [pattern] }],
  });
  it("refuses userinfo, a query, a fragment or a backslash in a pattern's host", () => {
    for (const pattern of [
      "https://user@site.test/*",
      "https://site.test?foo/*",
      "https://site.test#foo/*",
      "https://site.test\\foo/*",
    ])
      expect(reach(ext("page.html"), "https://site.test", only(pattern)), pattern).toBe(false);
  });
});

describe("a dynamic address judged at its hop (R1)", () => {
  const dynamicManifest = {
    manifest_version: 3,
    web_accessible_resources: [
      { resources: ["dyn.html"], matches: ["https://site.test/*"], use_dynamic_url: true },
    ],
  };
  it("counts a use_dynamic_url entry as listed only for the hop", () => {
    expect(reach(ext("dyn.html"), web, dynamicManifest)).toBe(false);
    expect(reach(ext("dyn.html"), web, dynamicManifest, { dynamicAlias: true })).toBe(true);
    expect(
      reach(ext("dyn.html"), "https://evil.test", dynamicManifest, { dynamicAlias: true }),
    ).toBe(false);
    expect(
      reach(ext("dyn.html"), web, dynamicManifest, { dynamicAlias: true, redirect: true }),
    ).toBe(true);
    expect(reach(ext("nonwar.html"), web, dynamicManifest, { dynamicAlias: true })).toBe(false);
  });

  it("refuses a redirect into a dynamic address from an origin that is not the web", () => {
    const dynamic = "chrome-extension://e7c508fa-1f5c-471b-9065-5bf03292faaa/dyn.html";
    expect(reach(dynamic, "https://idp.test", mv3, { redirect: true })).toBe(true);
    expect(reach(dynamic, undefined, mv3, { redirect: true })).toBe(false);
    expect(reach(dynamic, `chrome-extension://${id}`, mv3, { redirect: true })).toBe(false);
  });
});
