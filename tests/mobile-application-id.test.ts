import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  opensteerMobileAccountOAuthCallback,
  opensteerMobileApplicationId,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
  opensteerNativeClients,
} from "../packages/core/src/identity.js";

/**
 * `apps/mobile/app.config.ts` spells the application id as a literal, because
 * Expo loads that file through Node and Node cannot follow this repository's
 * NodeNext `./x.js` specifiers into `@opensteer/core`. The literal is what the
 * operating system registers: the bundle identifier, the Android package, and
 * the private-use URL scheme that both OAuth callbacks and every notification
 * deep link are addressed to. A drift between it and `@opensteer/core` would
 * not fail a build — it would silently make a signed-in phone unreachable — so
 * the two are pinned to each other here.
 *
 * The runtime constants come from Core's source entry while Expo's config is
 * read as text because Expo deliberately repeats the application-id literal.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "..");

function source(...segments: readonly string[]): string {
  return readFileSync(path.join(repositoryRoot, ...segments), "utf8");
}

const configSource = source("apps", "mobile", "app.config.ts");
const deepLinkSource = source("packages", "core", "src", "deep-links.ts");

function literal(text: string, name: string): string | undefined {
  return new RegExp(`^export const ${name} = "([^"]+)";$`, "mu").exec(text)?.[1];
}

describe("the mobile application id", () => {
  it("is the mobile entry in the closed native-client registry", () => {
    expect(
      opensteerNativeClients.find((client) => client.clientId === opensteerMobileOAuthClientId),
    ).toMatchObject({
      accountCallback: opensteerMobileAccountOAuthCallback,
      application: "mobile",
      applicationId: opensteerMobileApplicationId,
      hostCallback: opensteerMobileHostOAuthCallback,
    });
  });

  it("is the literal apps/mobile/app.config.ts registers", () => {
    expect(/^const applicationId = "([^"]+)";$/mu.exec(configSource)?.[1]).toBe(
      opensteerMobileApplicationId,
    );
  });

  it("is used as the scheme, the bundle identifier, and the Android package", () => {
    expect(configSource).toContain("scheme: applicationId,");
    expect(configSource).toContain("bundleIdentifier: applicationId,");
    expect(configSource).toContain("package: applicationId,");
  });

  it("is the private-use scheme both OAuth callbacks are registered under", () => {
    for (const callback of [
      opensteerMobileAccountOAuthCallback,
      opensteerMobileHostOAuthCallback,
    ]) {
      expect(new URL(callback).protocol).toBe(`${opensteerMobileApplicationId}:`);
    }
  });

  it("is the scheme notification deep links are addressed to", () => {
    expect(literal(deepLinkSource, "mobileDeepLinkScheme")).toBe(opensteerMobileApplicationId);
  });
});
