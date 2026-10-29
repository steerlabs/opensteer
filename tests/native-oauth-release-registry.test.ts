import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  opensteerAccountNativeOAuthClients,
  opensteerHostNativeOAuthClients,
  opensteerMobileAccountOAuthCallback,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "../packages/core/src/identity.js";
import { describe, expect, it } from "vitest";

interface NativeReleaseIdentity {
  readonly clientId: string;
  readonly accountCallback: string;
  readonly hostCallback: string;
}

const desktopReleases = [
  "../apps/desktop/src/releases/desktop-release.source.json",
  "../apps/desktop/src/releases/desktop-release.beta.json",
].map((path) => {
  const release = JSON.parse(
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"),
  ) as {
    readonly oauth: NativeReleaseIdentity;
    readonly capabilities: { readonly connect: boolean };
  };
  return { ...release.oauth, connect: release.capabilities.connect };
});

const mobileRelease: NativeReleaseIdentity & { readonly connect: boolean } = {
  connect: true,
  accountCallback: opensteerMobileAccountOAuthCallback,
  clientId: opensteerMobileOAuthClientId,
  hostCallback: opensteerMobileHostOAuthCallback,
};

describe("native OAuth release registry", () => {
  it.each([...desktopReleases, mobileRelease])(
    "registers $clientId on every authorization server it can reach",
    (release) => {
      if (release.connect)
        expect(opensteerAccountNativeOAuthClients).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              clientId: release.clientId,
              redirectUris: expect.arrayContaining([release.accountCallback]),
            }),
          ]),
        );
      expect(opensteerHostNativeOAuthClients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            clientId: release.clientId,
            redirectUris: expect.arrayContaining([release.hostCallback]),
          }),
        ]),
      );
    },
  );
});
