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
        OPENSTEER_BROWSER_PROXY_URL: "http://browser-egress:4313",
        OPENSTEER_CHROMIUM_SANDBOX: "true",
      }),
    ).toMatchObject({
      chromiumSandbox: true,
      proxyUrl: "http://browser-egress:4313",
    });
  });

  describe("bridge-only Browser Runtime", () => {
    const base = {
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "browser-bridge-token-with-enough-entropy",
      OPENSTEER_BROWSER_PROFILE_ROOT: "/profiles",
      OPENSTEER_BROWSER_RUNTIME_ID: "runtime_main",
      OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
    };

    it.each(["http://127.23.4.5:4313", "http://[::1]:4313", "http://localhost:4313"])(
      "admits the loopback origin %s",
      (proxyUrl) => {
        expect(
          readBrowserRuntimeConfig({
            ...base,
            OPENSTEER_MODE: "production",
            OPENSTEER_CHROMIUM_SANDBOX: "true",
            OPENSTEER_BROWSER_PROXY_URL: proxyUrl,
          }),
        ).toMatchObject({ relay: undefined, chromiumSandbox: true, proxyUrl });
      },
    );

    it.each([
      "http://browser-egress:4313",
      "http://0.0.0.0:4313",
      "http://localhost.example.com:4313",
      "http://127.0.0.1:4313/path",
      "http://user:pass@127.0.0.1:4313",
      "https://127.0.0.1:4313",
    ])("refuses a non-loopback or malformed HTTP origin %s", (proxyUrl) => {
      expect(() =>
        readBrowserRuntimeConfig({ ...base, OPENSTEER_BROWSER_PROXY_URL: proxyUrl }),
      ).toThrow(/origin/i);
    });

    it("requires sandboxing in production even without a proxy", () => {
      expect(() => readBrowserRuntimeConfig({ ...base, OPENSTEER_MODE: "production" })).toThrow(
        /sandbox/i,
      );
      expect(readBrowserRuntimeConfig(base)).toMatchObject({
        chromiumSandbox: false,
        proxyUrl: undefined,
      });
    });
  });

  it("allows dynamic Host key bootstrap only when a device bridge token is configured", () => {
    const config = readBrowserRuntimeConfig({
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "local-browser-bridge-token-with-entropy",
      OPENSTEER_BROWSER_PROFILE_ROOT: "/var/lib/opensteer/browser-profiles",
      OPENSTEER_BROWSER_RUNTIME_ID: "runtime_main",
      OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
      OPENSTEER_BROWSER_MEMORY_BUDGET_MB: "512",
    });
    expect(config.publicKeys.size).toBe(0);
    expect(config.bridgeToken).toBe("local-browser-bridge-token-with-entropy");
    expect(config.memoryBudgetBytes).toBe(512 * 1024 ** 2);
  });

  it.each([
    ["missing runtime id", { OPENSTEER_BROWSER_RUNTIME_ID: undefined }],
    ["relative executable", { OPENSTEER_CHROMIUM_EXECUTABLE: "chromium" }],
    ["invalid public keys", { OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: "[]" }],
    ["invalid port", { OPENSTEER_BROWSER_PORT: "70000" }],
    ["invalid boolean", { OPENSTEER_BROWSER_HEADLESS: "yes" }],
    ["invalid memory budget", { OPENSTEER_BROWSER_MEMORY_BUDGET_MB: "0" }],
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

describe("pooled Browser Runtime (pool-runtime-in-guest.md, decisions 2 and 7)", () => {
  const spki = () =>
    generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
  const pooled = {
    OPENSTEER_BROWSER_BRIDGE_TOKEN: "browser-bridge-token-with-enough-entropy",
    OPENSTEER_BROWSER_PROFILE_ROOT: "/profiles",
    OPENSTEER_BROWSER_RUNTIME_ID: "browser-main",
    OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
    OPENSTEER_CHROMIUM_SANDBOX: "true",
    OPENSTEER_MODE: "production",
    OPENSTEER_BROWSER_PROXY_URL: "http://172.16.0.1:3128",
    OPENSTEER_BROWSER_POOL_PROXY: "172.16.0.1:3128",
    OPENSTEER_BROWSER_POOL_SLOT: "slot-a",
    OPENSTEER_BROWSER_POOL_CONTROLLER_KEY: spki(),
    OPENSTEER_BROWSER_POOL_FLOOR: "3.7",
    OPENSTEER_BROWSER_POOL_TICKET_KEY: `host-v1:${spki()}`,
  };

  it("takes its slot, controller key, floor and ticket key from its boot", () => {
    const config = readBrowserRuntimeConfig(pooled);
    expect(config.pool).toMatchObject({ slot: "slot-a", floor: { term: 3, sequence: 7 } });
    expect([...config.publicKeys.keys()]).toEqual(["host-v1"]);
    expect(config.proxyUrl).toBe("http://172.16.0.1:3128");
  });

  it("refuses a partial boot identity", () => {
    for (const key of [
      "OPENSTEER_BROWSER_POOL_SLOT",
      "OPENSTEER_BROWSER_POOL_CONTROLLER_KEY",
      "OPENSTEER_BROWSER_POOL_FLOOR",
      "OPENSTEER_BROWSER_POOL_TICKET_KEY",
    ]) {
      const partial: Record<string, string> = { ...pooled };
      delete partial[key];
      expect(() => readBrowserRuntimeConfig(partial)).toThrow(key);
    }
  });

  it("refuses a malformed floor, key or slot", () => {
    for (const [key, value] of [
      ["OPENSTEER_BROWSER_POOL_FLOOR", "3"],
      ["OPENSTEER_BROWSER_POOL_FLOOR", "0.1"],
      ["OPENSTEER_BROWSER_POOL_CONTROLLER_KEY", "bm90IGEga2V5"],
      ["OPENSTEER_BROWSER_POOL_TICKET_KEY", spki()],
      ["OPENSTEER_BROWSER_POOL_SLOT", "a slot"],
    ] as const)
      expect(() => readBrowserRuntimeConfig({ ...pooled, [key]: value })).toThrow();
  });

  it("accepts its slot's proxy and no other non-loopback proxy", () => {
    expect(() =>
      readBrowserRuntimeConfig({
        ...pooled,
        OPENSTEER_BROWSER_PROXY_URL: "http://172.16.0.5:3128",
      }),
    ).toThrow(/slot's egress proxy/u);
    expect(() =>
      readBrowserRuntimeConfig({ ...pooled, OPENSTEER_BROWSER_PROXY_URL: "http://127.0.0.1:3128" }),
    ).toThrow(/slot's egress proxy/u);
    const { OPENSTEER_BROWSER_PROXY_URL: _proxy, ...withoutProxy } = pooled;
    expect(() => readBrowserRuntimeConfig(withoutProxy)).toThrow(/slot's egress proxy/u);
  });

  it("refuses to run without its token or sandbox, as a relay, or with other ticket keys", () => {
    const { OPENSTEER_BROWSER_BRIDGE_TOKEN: _token, ...withoutToken } = pooled;
    expect(() => readBrowserRuntimeConfig(withoutToken)).toThrow(/bridge token/u);
    expect(() =>
      readBrowserRuntimeConfig({ ...pooled, OPENSTEER_CHROMIUM_SANDBOX: "false" }),
    ).toThrow(/sandbox/u);
    expect(() =>
      readBrowserRuntimeConfig({
        ...pooled,
        OPENSTEER_BROWSER_RELAY_HOST_URL: "http://127.0.0.1:4310",
        OPENSTEER_BROWSER_RUNTIME_DATA_DIR: "/runner",
      }),
    ).toThrow(/relay/u);
    expect(() =>
      readBrowserRuntimeConfig({
        ...pooled,
        OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: JSON.stringify({ other: publicKey }),
      }),
    ).toThrow(/ticket key/u);
  });

  it("leaves an ordinary bridge-only runtime's loopback rule as it was", () => {
    const ordinary = {
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "browser-bridge-token-with-enough-entropy",
      OPENSTEER_BROWSER_PROFILE_ROOT: "/profiles",
      OPENSTEER_BROWSER_RUNTIME_ID: "browser-main",
      OPENSTEER_CHROMIUM_EXECUTABLE: "/usr/bin/chromium",
      OPENSTEER_BROWSER_PROXY_URL: "http://172.16.0.1:3128",
    };
    expect(() => readBrowserRuntimeConfig(ordinary)).toThrow(/loopback egress proxy/u);
    expect(() =>
      readBrowserRuntimeConfig({ ...ordinary, OPENSTEER_BROWSER_POOL_PROXY: "172.16.0.1:3128" }),
    ).toThrow(/only for a pooled/u);
  });
});
