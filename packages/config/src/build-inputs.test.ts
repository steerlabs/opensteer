import { expect, test } from "vitest";
import {
  BuildSourceSchema,
  BuildImagesSchema,
  DesktopBuildSchema,
  MobileSigningSchema,
} from "./build-inputs.js";

const source = { url: "https://github.com/example/workspace", revision: "a".repeat(40) };
test("build source requires an HTTP(S) source URL and exact lowercase commit", () => {
  expect(BuildSourceSchema.parse(source)).toEqual(source);
  for (const value of [
    { ...source, url: "file:///private/source" },
    { ...source, revision: "main" },
    { ...source, revision: "A".repeat(40) },
    { ...source, secret: "no" },
  ])
    expect(BuildSourceSchema.safeParse(value).success).toBe(false);
});
test("image inputs have no registry defaults and reject unknown keys and empty references", () => {
  expect(BuildImagesSchema.parse({})).toEqual({});
  expect(
    BuildImagesSchema.parse({
      registry: "registry.example/team/images",
      cacheRegistry: "registry.example/team/cache",
    }),
  ).toEqual({
    registry: "registry.example/team/images",
    cacheRegistry: "registry.example/team/cache",
  });
  for (const value of [
    { registry: "" },
    { registry: "https://registry.example" },
    { project: "example" },
  ])
    expect(BuildImagesSchema.safeParse(value).success).toBe(false);
});
test("desktop inputs require explicit names and complete optional signing references", () => {
  const desktop = { channel: "beta", bundleId: "com.example.workspace", productName: "Workspace" };
  expect(DesktopBuildSchema.parse(desktop)).toEqual(desktop);
  expect(
    DesktopBuildSchema.parse({
      ...desktop,
      signing: {
        teamId: "A1B2C3D4E5",
        identity: "Developer ID Application: Example",
        notarizationProfile: "release-profile",
      },
    }).signing?.teamId,
  ).toBe("A1B2C3D4E5");
  for (const value of [
    {},
    { ...desktop, signing: { teamId: "A1B2C3D4E5" } },
    {
      ...desktop,
      signing: {
        teamId: "A1B2C3D4E5",
        identity: "x",
        notarizationProfile: "profile",
        password: "secret",
      },
    },
    { ...desktop, bundleId: "bad id" },
  ])
    expect(DesktopBuildSchema.safeParse(value).success).toBe(false);
});
test("mobile signing accepts file references, never embedded credentials", () => {
  const refs = {
    keystoreFile: "/inputs/release.keystore",
    keyAlias: "release",
    storePasswordFile: "/inputs/store-password",
    keyPasswordFile: "/inputs/key-password",
  };
  expect(MobileSigningSchema.parse(refs)).toEqual(refs);
  expect(MobileSigningSchema.safeParse({ ...refs, password: "secret" }).success).toBe(false);
  expect(MobileSigningSchema.safeParse({ ...refs, keystoreFile: "" }).success).toBe(false);
});

test("desktop signing accepts an optional absolute keychain-db reference", () => {
  const signing = { teamId: "A1B2C3D4E5", identity: "Example", notarizationProfile: "profile" };
  const desktop = { channel: "beta", bundleId: "com.example.app", productName: "Example" };
  expect(
    DesktopBuildSchema.parse({
      ...desktop,
      signing: { ...signing, keychain: "/inputs/release.keychain-db" },
    }).signing,
  ).toEqual({ ...signing, keychain: "/inputs/release.keychain-db" });
  for (const keychain of ["relative.keychain-db", "/inputs/wrong.keychain", ""]) {
    expect(
      DesktopBuildSchema.safeParse({ ...desktop, signing: { ...signing, keychain } }).success,
    ).toBe(false);
  }
});
