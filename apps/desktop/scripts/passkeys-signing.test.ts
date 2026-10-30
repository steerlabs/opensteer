import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
const require = createRequire(import.meta.url);
const capability = "com.apple.developer.web-browser.public-key-credential";
const { validatePasskeyProfile, passkeyInputPaths, validatePasskeyEntitlementInput } =
  require("./passkeys-signing.cjs") as {
    validatePasskeyProfile(
      profile: unknown,
      identity: { bundleId: string; teamId: string },
      now?: number,
      certificate?: Uint8Array,
    ): void;
    validatePasskeyEntitlementInput(input: unknown): void;
    passkeyInputPaths(
      env: NodeJS.ProcessEnv,
      channel: "stable" | "beta",
    ): { profile: string; entitlements: string } | undefined;
  };
const identity = { bundleId: "com.example.browser", teamId: "ABCDE12345" };
const profile = () => ({
  DeveloperCertificates: [certificates[0]!.raw.toString("base64")],
  Entitlements: {
    [capability]: true,
    "com.apple.application-identifier": `${identity.teamId}.${identity.bundleId}`,
    "com.apple.developer.team-identifier": identity.teamId,
  },
  TeamIdentifier: [identity.teamId],
  ExpirationDate: "2030-01-01T00:00:00Z",
  ProvisionsAllDevices: true,
  Platform: ["OSX"],
});

test.each(["stable", "beta"] as const)(
  "no passkey inputs leave %s release builder arguments unchanged",
  (channel) => {
    const { preparePasskeySigning } = require("./passkeys-signing.cjs") as {
      preparePasskeySigning(
        desktop: string,
        env: NodeJS.ProcessEnv,
        identity: { bundleId: string; teamId: string; channel: "stable" | "beta" },
      ): string[];
    };
    expect(
      preparePasskeySigning(
        "/unused",
        { OPENSTEER_DESKTOP_RELEASE: "1" },
        { ...identity, channel },
      ),
    ).toEqual([]);
  },
);

test("each channel requires its own pair of release-only inputs", () => {
  expect(passkeyInputPaths({}, "stable")).toBeUndefined();
  const env = {
    OPENSTEER_DESKTOP_RELEASE: "1",
    OPENSTEER_PASSKEYS_STABLE_PROFILE: "/profile",
    OPENSTEER_PASSKEYS_STABLE_ENTITLEMENTS: "/entitlements",
  };
  expect(passkeyInputPaths(env, "stable")).toEqual({
    profile: "/profile",
    entitlements: "/entitlements",
  });
  expect(passkeyInputPaths(env, "beta")).toBeUndefined();
  expect(() => passkeyInputPaths({ ...env, OPENSTEER_DESKTOP_RELEASE: "0" }, "stable")).toThrow();
  expect(() =>
    passkeyInputPaths({ ...env, OPENSTEER_PASSKEYS_STABLE_ENTITLEMENTS: undefined }, "stable"),
  ).toThrow();
});

test("only the granted capability is accepted as the external entitlement input", () => {
  expect(() => validatePasskeyEntitlementInput({ [capability]: true })).not.toThrow();
  for (const input of [
    {},
    { [capability]: false },
    { [capability]: true, "com.apple.security.get-task-allow": true },
  ])
    expect(() => validatePasskeyEntitlementInput(input)).toThrow();
});

test("requires a current Developer ID profile for this exact app, team and capability", () => {
  const good = profile();
  expect(() =>
    validatePasskeyProfile(good, identity, Date.UTC(2026, 0), certificates[0]!.raw),
  ).not.toThrow();
  for (const change of [
    { ExpirationDate: "2020-01-01" },
    { TeamIdentifier: ["OTHER12345"] },
    { ProvisionsAllDevices: false },
    { Platform: ["iOS"] },
    { Entitlements: { ...good.Entitlements, [capability]: false } },
    {
      Entitlements: {
        ...good.Entitlements,
        "com.apple.application-identifier": `${identity.teamId}.*`,
      },
    },
    { Entitlements: { ...good.Entitlements, "com.apple.developer.team-identifier": "OTHER12345" } },
  ])
    expect(() =>
      validatePasskeyProfile(
        { ...good, ...change },
        identity,
        Date.UTC(2026, 0),
        certificates[0]!.raw,
      ),
    ).toThrow();
});

test("provisioned release entitlements admit only the verified app identity", () => {
  const { validateReleaseEntitlements } = require("./macos-release-identity.cjs") as {
    validateReleaseEntitlements(
      values: Record<string, unknown>,
      identity?: { bundleId: string; teamId: string },
    ): void;
  };
  const entitlements = {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.device.audio-input": true,
    ...profile().Entitlements,
  };
  expect(() => validateReleaseEntitlements(entitlements)).toThrow();
  expect(() => validateReleaseEntitlements(entitlements, identity)).not.toThrow();
  expect(() =>
    validateReleaseEntitlements(
      { ...entitlements, "com.apple.developer.team-identifier": "OTHER12345" },
      identity,
    ),
  ).toThrow();
});

const certificateDirectory = mkdtempSync(join(tmpdir(), "passkey-certificates-"));
const certificates: X509Certificate[] = [];
beforeAll(() => {
  for (const name of ["original", "rotated"]) {
    const filename = join(certificateDirectory, `${name}.pem`);
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        join(certificateDirectory, `${name}.key`),
        "-out",
        filename,
        "-days",
        "1",
        "-subj",
        `/CN=Developer ID Application: Example (${identity.teamId})/OU=${identity.teamId}`,
      ],
      { stdio: "pipe", timeout: 10_000 },
    );
    certificates.push(new X509Certificate(readFileSync(filename)));
  }
});
afterAll(() => rmSync(certificateDirectory, { recursive: true, force: true }));

test("a current same-team profile rejects a different signing certificate", () => {
  const original = certificates[0]!;
  const rotated = certificates[1]!;
  expect(original.subject).toBe(rotated.subject);
  const grant = { ...profile(), DeveloperCertificates: [original.raw.toString("base64")] };
  expect(() =>
    validatePasskeyProfile(grant, identity, Date.UTC(2026, 0), original.raw),
  ).not.toThrow();
  expect(() => validatePasskeyProfile(grant, identity, Date.UTC(2026, 0), rotated.raw)).toThrow(
    /certificate/u,
  );
});

test("certificate lookup keeps the selected keychain and rejects ambiguous rotated identities", () => {
  const { selectedSigningCertificate } = require("./passkeys-signing.cjs") as {
    selectedSigningCertificate(
      signing: { identity: string; keychain?: string },
      command: (program: string, args: string[]) => string,
    ): Buffer;
  };
  const signing = {
    identity: "Developer ID Application: Example (ABCDE12345)",
    keychain: "/release.keychain-db",
  };
  const calls: string[][] = [];
  const command = (_program: string, args: string[]) => {
    calls.push(args);
    return args[0] === "find-identity"
      ? `  1) ${certificates[0]!.fingerprint.replaceAll(":", "")} "${signing.identity}"`
      : certificates.map((cert) => cert.toString()).join("\n");
  };
  expect(selectedSigningCertificate(signing, command)).toEqual(certificates[0]!.raw);
  expect(calls).toEqual([
    ["find-identity", "-v", "-p", "codesigning", signing.keychain],
    ["find-certificate", "-a", "-c", signing.identity, "-p", signing.keychain],
  ]);
  expect(() =>
    selectedSigningCertificate(signing, () =>
      certificates
        .map(
          (cert, index) =>
            `  ${index + 1}) ${cert.fingerprint.replaceAll(":", "")} "${signing.identity}"`,
        )
        .join("\n"),
    ),
  ).toThrow(/ambiguous/u);
});

test("after-sign certificate extraction uses the signed leaf and removes temporary certificates", () => {
  const { signedAppCertificate } = require("./passkeys-signing.cjs") as {
    signedAppCertificate(app: string, command: (program: string, args: string[]) => string): Buffer;
  };
  let prefix = "";
  const leaf = signedAppCertificate("/Example.app", (program, args) => {
    expect(program).toBe("/usr/bin/codesign");
    expect(args.slice(0, 2)).toEqual(["-d", "--extract-certificates"]);
    expect(args[3]).toBe("/Example.app");
    prefix = args[2]!;
    writeFileSync(`${prefix}0`, certificates[1]!.raw);
    writeFileSync(`${prefix}1`, certificates[0]!.raw);
    return "";
  });
  expect(leaf).toEqual(certificates[1]!.raw);
  expect(existsSync(`${prefix}0`)).toBe(false);
  expect(() => validatePasskeyProfile(profile(), identity, Date.UTC(2026, 0), leaf)).toThrow(
    /certificate/u,
  );
});
