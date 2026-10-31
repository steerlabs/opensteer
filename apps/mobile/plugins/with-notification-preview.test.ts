import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(new URL("../package.json", import.meta.url));
const plugin = require("./plugins/with-notification-preview.cjs");
describe("notification preview plugin", () => {
  it("replaces Expo and Firebase services idempotently with one private handler", () => {
    const value = {
      manifest: {
        $: {},
        application: [
          {
            service: [
              {
                $: {
                  "android:name": "expo.modules.notifications.service.ExpoFirebaseMessagingService",
                },
              },
            ],
          },
        ],
      },
    };
    plugin.manifest(value);
    const once = JSON.stringify(value);
    plugin.manifest(value);
    expect(JSON.stringify(value)).toBe(once);
    const services = value.manifest.application[0]!.service;
    expect(
      services.filter((s: { $: Record<string, string> }) => s.$["tools:node"] !== "remove"),
    ).toEqual([
      expect.objectContaining({
        $: {
          "android:name": "com.opensteer.notificationpreview.OpensteerFirebaseMessagingService",
          "android:exported": "false",
        },
      }),
    ]);
  });
});

it("embeds one extension target with standalone native sources and signing settings", () => {
  const xcode = require(
    require.resolve("xcode", { paths: [require.resolve("expo/config-plugins")] }),
  );
  const project = xcode.project(
    new URL(
      "../modules/iphone-apps/fixture/IphoneAppsFixture.xcodeproj/project.pbxproj",
      import.meta.url,
    ).pathname,
  );
  const parser = require(
    require.resolve("xcode/lib/parser/pbxproj", {
      paths: [require.resolve("expo/config-plugins")],
    }),
  );
  const fixture = readFileSync(project.filepath, "utf8");
  project.hash = parser.parse(fixture.replace(/([A-F0-9]{24}|Base)\)/g, "$1,)"));
  const sections: Record<string, Record<string, unknown>> = {};
  for (const [id, value] of Object.entries(project.hash.project.objects) as [
    string,
    { isa: string; name?: string; path?: string },
  ][]) {
    const section = (sections[value.isa] ??= {});
    section[id] = value;
    section[`${id}_comment`] = value.name ?? value.path ?? value.isa;
  }
  function references(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map((item) =>
        typeof item === "string" && /^[A-F0-9]{24}$/.test(item)
          ? { value: item, comment: "fixture" }
          : references(item),
      );
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        (value as Record<string, unknown>)[key] = references(item);
    return value;
  }
  project.hash.project.objects = references(sections);
  // Like Expo's prebuild template: the app target keeps MARKETING_VERSION = 1.0.
  for (const config of Object.values(project.pbxXCBuildConfigurationSection()) as {
    buildSettings?: Record<string, string>;
  }[])
    if (config.buildSettings)
      Object.assign(config.buildSettings, {
        PRODUCT_BUNDLE_IDENTIFIER: "com.opensteer.mobile",
        MARKETING_VERSION: "1.0",
        CURRENT_PROJECT_VERSION: "1",
      });
  plugin.project(project, { version: "1.2.3", ios: { buildNumber: "42" } });
  const once = project.writeSync();
  plugin.project(project, { version: "1.2.3", ios: { buildNumber: "42" } });
  expect(project.writeSync()).toBe(once);
  expect(once).toContain("com.opensteer.mobile.NotificationService");
  expect(once).toContain("APPLICATION_EXTENSION_API_ONLY = YES");
  // The extension must match the app's Info.plist, which Expo writes from config.
  expect(once).toContain("MARKETING_VERSION = 1.2.3;");
  expect(once).toContain("CURRENT_PROJECT_VERSION = 42;");
  expect(once).toContain("SKIP_INSTALL = YES");
  expect(once).toContain("NotificationService.swift");
  expect(once).toContain("KeyStore.swift");
  expect(once).toContain("CryptoKit.framework");
  expect(once).toContain("PBXCopyFilesBuildPhase");
  expect(once).not.toContain("keychain-access-groups");
});
