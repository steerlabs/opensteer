import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserRuntimeEnvironmentKeys,
  readBrowserRuntimeConfig,
} from "../apps/browser-runtime/src/config.js";
import { managedBrowserRuntimeEnvironment } from "../apps/control-plane/src/cloud/kubernetes-managed-deployment-resources.js";

const enrollmentToken = "runner-enrollment-token-with-enough-entropy";
const bridgeToken = "browser-bridge-token-with-enough-entropy";

describe("deployed Browser Runtime configuration", () => {
  it("parses the exact managed workload environment through the runtime boundary", () => {
    const emitted = managedBrowserRuntimeEnvironment("https://managed.opensteer.test");
    const environment = Object.fromEntries(
      emitted.map((entry) => [
        entry.name,
        entry.value ??
          (entry.name === browserRuntimeEnvironmentKeys.bridgeToken
            ? bridgeToken
            : enrollmentToken),
      ]),
    );

    expectRelayKeys(new Set(emitted.map(({ name }) => name)));
    expect(readBrowserRuntimeConfig(environment).relay).toMatchObject({
      bridgeToken,
      enrollmentToken,
      hostUrl: new URL("https://managed.opensteer.test"),
      mode: "production",
    });
  });

  it("parses the exact self-host Compose environment through the runtime boundary", async () => {
    const source = await readFile(resolve("deploy/self-host/compose.yaml"), "utf8");
    const emitted = composeServiceEnvironment(source, "browser-runtime");
    expectRelayKeys(new Set(Object.keys(emitted).map((key) => key.replace(/_FILE$/u, ""))));
    for (const [key, value] of Object.entries(emitted)) {
      if (!key.endsWith("_FILE")) continue;
      delete emitted[key];
      emitted[key.slice(0, -"_FILE".length)] = key.includes("BRIDGE")
        ? bridgeToken
        : enrollmentToken;
      void value;
    }
    emitted.OPENSTEER_MODE = "production";

    expect(readBrowserRuntimeConfig(emitted).relay).toMatchObject({
      bridgeToken,
      controlCaPath: "/control-ca/root.crt",
      enrollmentToken,
      hostUrl: new URL("https://gateway:8443"),
      mode: "production",
    });
  });
});

function expectRelayKeys(keys: ReadonlySet<string>): void {
  for (const key of [
    browserRuntimeEnvironmentKeys.bridgeToken,
    browserRuntimeEnvironmentKeys.chromiumSandbox,
    browserRuntimeEnvironmentKeys.enrollmentToken,
    browserRuntimeEnvironmentKeys.mode,
    browserRuntimeEnvironmentKeys.profileRoot,
    browserRuntimeEnvironmentKeys.proxyUrl,
    browserRuntimeEnvironmentKeys.relayHostUrl,
    browserRuntimeEnvironmentKeys.runtimeDataDirectory,
    browserRuntimeEnvironmentKeys.runtimeId,
  ]) {
    expect(keys.has(key), `${key} is emitted`).toBe(true);
  }
}

function composeServiceEnvironment(source: string, service: string): NodeJS.ProcessEnv {
  const lines = source.split("\n");
  const serviceStart = lines.findIndex((line) => line === `  ${service}:`);
  if (serviceStart < 0) throw new Error(`Compose service ${service} is missing`);
  const environmentStart = lines.findIndex(
    (line, index) => index > serviceStart && line === "    environment:",
  );
  if (environmentStart < 0) throw new Error(`Compose service ${service} has no environment`);
  const environment: NodeJS.ProcessEnv = {};
  for (const line of lines.slice(environmentStart + 1)) {
    if (/^    \S/u.test(line)) break;
    const match = /^      ([A-Z][A-Z0-9_]+):\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    environment[match[1]!] = match[2]!.replace(/^['"]|['"]$/gu, "");
  }
  return environment;
}
