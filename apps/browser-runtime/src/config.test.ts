import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readBrowserRuntimeConfig } from "./config.js";

const publicKey = generateKeyPairSync("ed25519")
  .publicKey.export({
    format: "pem",
    type: "spki",
  })
  .toString();

describe("readBrowserRuntimeConfig", () => {
  it("fails closed when production hosted Chromium lacks sandbox or proxy enforcement", () => {
    const base = {
      OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: JSON.stringify({ host: publicKey }),
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "browser-bridge-token-with-enough-entropy",
      OPENSTEER_BROWSER_PROFILE_ROOT: "/profiles",
      OPENSTEER_BROWSER_RELAY_HOST_URL: "http://127.0.0.1:4310",
      OPENSTEER_BROWSER_RUNTIME_DATA_DIR: "/runner",
      OPENSTEER_BROWSER_RUNTIME_ID: "runtime_main",
      OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
      OPENSTEER_MODE: "production",
    };
    expect(() => readBrowserRuntimeConfig(base)).toThrow(/sandbox/i);
    expect(() => readBrowserRuntimeConfig({ ...base, OPENSTEER_CHROMIUM_SANDBOX: "true" })).toThrow(
      /egress proxy/i,
    );
    expect(
      readBrowserRuntimeConfig({
        ...base,
        OPENSTEER_BROWSER_PROFILE_READY_INTERNAL_URL: "http://host:4310",
        OPENSTEER_BROWSER_PROXY_URL: "http://browser-egress:4313",
        OPENSTEER_CHROMIUM_SANDBOX: "true",
      }),
    ).toMatchObject({
      chromiumSandbox: true,
      profileReadyTrustedHttpOrigin: "http://host:4310",
      proxyUrl: "http://browser-egress:4313",
    });
  });

  it("accepts only one explicit private HTTP origin for Host profile state", () => {
    const base = {
      OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: JSON.stringify({ host: publicKey }),
      OPENSTEER_BROWSER_PROFILE_ROOT: "/profiles",
      OPENSTEER_BROWSER_RUNTIME_ID: "runtime_main",
      OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
    };
    expect(
      readBrowserRuntimeConfig({
        ...base,
        OPENSTEER_BROWSER_PROFILE_READY_INTERNAL_URL: "http://host:4310",
      }).profileReadyTrustedHttpOrigin,
    ).toBe("http://host:4310");
    expect(() =>
      readBrowserRuntimeConfig({
        ...base,
        OPENSTEER_BROWSER_PROFILE_READY_INTERNAL_URL: "http://host:4310/private",
      }),
    ).toThrow(/HTTP origin/i);
  });

  it("allows dynamic Host key bootstrap only when a device bridge token is configured", () => {
    const config = readBrowserRuntimeConfig({
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "local-browser-bridge-token-with-entropy",
      OPENSTEER_BROWSER_PROFILE_ROOT: "/var/lib/opensteer/browser-profiles",
      OPENSTEER_BROWSER_RUNTIME_ID: "runtime_main",
      OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
    });
    expect(config.publicKeys.size).toBe(0);
    expect(config.bridgeToken).toBe("local-browser-bridge-token-with-entropy");
  });

  it.each([
    ["missing runtime id", { OPENSTEER_BROWSER_RUNTIME_ID: undefined }],
    ["relative executable", { OPENSTEER_CHROMIUM_EXECUTABLE: "chromium" }],
    ["invalid public keys", { OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: "[]" }],
    ["invalid port", { OPENSTEER_BROWSER_PORT: "70000" }],
    ["invalid boolean", { OPENSTEER_BROWSER_HEADLESS: "yes" }],
    ["invalid profile capacity", { OPENSTEER_BROWSER_MAX_PROFILE_HOSTS: "0" }],
    ["invalid session capacity", { OPENSTEER_BROWSER_MAX_SESSIONS_PER_PROFILE: "129" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      readBrowserRuntimeConfig({
        OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: JSON.stringify({ host: publicKey }),
        OPENSTEER_BROWSER_PROFILE_ROOT: "/profiles",
        OPENSTEER_BROWSER_RUNTIME_ID: "runtime_main",
        OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
        ...override,
      }),
    ).toThrow();
  });
});
