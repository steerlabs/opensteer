import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canAccessCookieUrl,
  canReadTabDetails,
  compareVersions,
  extensionIdFromOrigin,
  globMatch,
  hasHostPermission,
  isExtensionId,
  matchesPattern,
  patternCovers,
  permissionWarnings,
  permissionsExpanded,
  resolveExtensionFile,
  resolveExtensionPageUrl,
  sameApprovedManifest,
  siteAccess,
  validateExtensionUrl,
} from "./permissions.js";

const extId = "abcdefghijklmnopabcdefghijklmnop";

describe("match patterns and permission checks", () => {
  it("matches Chrome match patterns without regex escape pitfalls", () => {
    expect(matchesPattern("<all_urls>", "https://example.com/path?q=1")).toBe(true);
    expect(
      matchesPattern("<all_urls>", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html"),
    ).toBe(false);
    expect(matchesPattern("https://*.example.com/*", "https://example.com/")).toBe(true);
    expect(matchesPattern("https://*.example.com/*", "https://sub.example.com/a")).toBe(true);
    expect(matchesPattern("https://*.example.com/*", "https://evil-example.com/a")).toBe(false);
    expect(matchesPattern("https://example.com/app/*", "https://example.com/app/x")).toBe(true);
    expect(matchesPattern("https://example.com/app/*", "http://example.com/app/x")).toBe(false);
  });

  it("enforces Chrome rules for reading tab details and accessing cookies", () => {
    const minimal = { manifest_version: 3, permissions: ["storage"] };
    expect(canReadTabDetails(minimal, "https://bank.test/account", false)).toBe(false);
    expect(canReadTabDetails(minimal, "https://bank.test/account", true)).toBe(true);
    expect(canReadTabDetails({ permissions: ["tabs"] }, "https://bank.test/account", false)).toBe(
      true,
    );
    expect(
      canReadTabDetails(
        { host_permissions: ["https://bank.test/*"] },
        "https://bank.test/account",
        false,
      ),
    ).toBe(true);

    expect(canAccessCookieUrl(minimal, "https://bank.test/")).toBe(false);
    expect(canAccessCookieUrl({ permissions: ["cookies"] }, "https://bank.test/")).toBe(false);
    expect(
      canAccessCookieUrl(
        { permissions: ["cookies"], host_permissions: ["https://example.com/*"] },
        "https://bank.test/",
      ),
    ).toBe(false);
    expect(
      canAccessCookieUrl(
        { permissions: ["cookies"], host_permissions: ["https://bank.test/*"] },
        "https://bank.test/login",
      ),
    ).toBe(true);
  });

  it("detects permission expansion across updates, including schemes and content-script scope", () => {
    const v1 = {
      manifest_version: 3,
      version: "1.0.0",
      permissions: ["storage"],
      host_permissions: ["http://*/*"],
      content_scripts: [
        {
          matches: ["https://example.com/*"],
          exclude_matches: ["https://example.com/private/*"],
          all_frames: false,
        },
      ],
    };
    expect(permissionsExpanded(v1, { ...v1, version: "1.0.1" })).toBe(false);
    expect(permissionsExpanded(v1, { ...v1, permissions: ["storage", "cookies"] })).toBe(true);
    // http://*/* must NOT cover https://*/*
    expect(patternCovers("http://*/*", "https://bank.test/*")).toBe(false);
    expect(patternCovers("*://*/*", "https://bank.test/*")).toBe(true);
    expect(
      permissionsExpanded(v1, {
        ...v1,
        host_permissions: ["http://*/*", "https://bank.test/*"],
      }),
    ).toBe(true);
    // Removing exclude_matches or enabling all_frames expands content-script scope.
    expect(
      permissionsExpanded(v1, {
        ...v1,
        content_scripts: [{ matches: ["https://example.com/*"], all_frames: false }],
      }),
    ).toBe(true);
    expect(
      permissionsExpanded(v1, {
        ...v1,
        content_scripts: [
          {
            matches: ["https://example.com/*"],
            exclude_matches: ["https://example.com/private/*"],
            all_frames: true,
          },
        ],
      }),
    ).toBe(true);
    // Linear-time globMatch handles adversarial repeated wildcards without backtracking.
    expect(globMatch(`${"*a".repeat(40)}b`, "a".repeat(200))).toBe(false);
    expect(
      permissionWarnings({
        permissions: ["tabs", "cookies", "contextMenus", "notifications", "scripting"],
        host_permissions: ["https://example.com/*"],
      }),
    ).toEqual([
      "It can read and change your data on example.com.",
      "Read your browsing history.",
      "Read and change your cookies.",
      "Add items to your right-click menu.",
      "Display notifications.",
      "Run scripts on websites you visit.",
    ]);
    // Wildcard host with narrow path still warns as all websites.
    expect(siteAccess({ host_permissions: ["https://*/login"] })).toBe(
      "It can read and change your data on all websites.",
    );
    // Expanding include_globs, exclude_globs, or match_origin_as_fallback triggers permissionsExpanded.
    const globBase = {
      content_scripts: [
        {
          matches: ["https://example.com/*"],
          include_globs: ["*docs*"],
          exclude_globs: ["*secret*"],
          match_origin_as_fallback: false,
        },
      ],
    };
    expect(
      permissionsExpanded(globBase, {
        content_scripts: [{ matches: ["https://example.com/*"], exclude_globs: ["*secret*"] }],
      }),
    ).toBe(true);
    expect(
      permissionsExpanded(globBase, {
        content_scripts: [{ matches: ["https://example.com/*"], include_globs: ["*docs*"] }],
      }),
    ).toBe(true);
    expect(
      permissionsExpanded(globBase, {
        content_scripts: [
          {
            matches: ["https://example.com/*"],
            include_globs: ["*docs*"],
            exclude_globs: ["*secret*"],
            match_origin_as_fallback: true,
          },
        ],
      }),
    ).toBe(true);
    // Chrome Web Store URLs are strictly outside host permission scope.
    expect(
      hasHostPermission({ host_permissions: ["<all_urls>"] }, "https://chromewebstore.google.com/"),
    ).toBe(false);
    expect(
      hasHostPermission(
        { host_permissions: ["<all_urls>"] },
        "https://chrome.google.com/webstore/detail/abc",
      ),
    ).toBe(false);
  });

  it("checks approved manifests strictly", () => {
    const approved = {
      version: "2.0.0",
      permissions: ["storage", "tabs"],
      host_permissions: ["https://a.test/*"],
      content_scripts: [{ matches: ["https://a.test/*"] }],
    };
    expect(
      sameApprovedManifest(approved, {
        ...approved,
        permissions: ["tabs", "storage"],
      }),
    ).toBe(true);
    expect(sameApprovedManifest(approved, { ...approved, version: "2.0.1" })).toBe(false);
    expect(
      sameApprovedManifest(approved, { ...approved, permissions: ["storage", "tabs", "cookies"] }),
    ).toBe(false);
  });
});

describe("path, URL, and origin hygiene", () => {
  it("prevents directory traversal and sibling-prefix escapes", () => {
    const root = "/tmp/profile/ext";
    expect(resolveExtensionFile(root, "icons/icon32.png")).toBe(
      path.resolve(root, "icons/icon32.png"),
    );
    expect(resolveExtensionFile(root, "../ext-secret/key.txt")).toBeNull();
    expect(resolveExtensionFile(root, "../../etc/passwd")).toBeNull();
    expect(resolveExtensionFile(root, "icon\0.png")).toBeNull();
  });

  it("allowlists only web URLs, about:blank, and the extension's own pages", () => {
    expect(validateExtensionUrl("https://example.com/a", extId)).toBe("https://example.com/a");
    expect(validateExtensionUrl("about:blank", extId)).toBe("about:blank");
    expect(validateExtensionUrl("options.html", extId)).toBe(
      `chrome-extension://${extId}/options.html`,
    );
    expect(() => validateExtensionUrl("javascript:alert(1)", extId)).toThrow();
    expect(() => validateExtensionUrl("file:///etc/passwd", extId)).toThrow();
    expect(() => validateExtensionUrl("opensteer-app://main/index.html", extId)).toThrow();
    expect(() =>
      validateExtensionUrl("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/popup.html", extId),
    ).toThrow();
  });

  it("resolves extension pages strictly inside the extension origin", () => {
    expect(resolveExtensionPageUrl(extId, "popup.html")).toBe(
      `chrome-extension://${extId}/popup.html`,
    );
    expect(resolveExtensionPageUrl(extId, "https://phishing.test/login")).toBeNull();
    expect(
      resolveExtensionPageUrl(extId, "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/p.html"),
    ).toBeNull();
  });

  it("extracts extension IDs strictly from chrome-extension origins", () => {
    expect(extensionIdFromOrigin(`chrome-extension://${extId}`)).toBe(extId);
    expect(extensionIdFromOrigin(`chrome-extension://${extId}/`)).toBe(extId);
    expect(extensionIdFromOrigin("https://chromewebstore.google.com")).toBeNull();
    expect(extensionIdFromOrigin("chrome-extension://not-valid")).toBeNull();
    expect(isExtensionId(extId)).toBe(true);
    expect(compareVersions("1.2.3", "1.2.10")).toBeLessThan(0);
    expect(siteAccess({ host_permissions: ["<all_urls>"] })).toBe(
      "It can read and change your data on all websites.",
    );
  });
});
