import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  auditSigningInvocations,
  isAuditedSigningSource,
} from "../scripts/signing-invocation-guard.js";

const root = path.resolve(import.meta.dirname, "..");
test("every tracked signing and notarization invocation has reviewed keychain routing", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(isAuditedSigningSource)
    .map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
  expect(auditSigningInvocations(files)).toEqual([]);
});
test("shell verification needs no keychain routing, but a signer on the same line still fails", () => {
  for (const source of [
    '  codesign --verify --deep --strict "$1" 2>/dev/null || return 1',
    "  codesign -dv --verbose=4 \"$1\" 2>&1 | grep -qx 'TeamIdentifier=B47U2LLKHW'",
  ])
    expect(auditSigningInvocations([{ file: "scripts/install.sh", source }])).toEqual([]);
  for (const source of [
    'codesign --verify "$app" && codesign --sign "$identity" "$app"',
    'codesign -dv -s "$identity" "$app"',
    'codesign --force --sign - "$app"',
  ])
    expect(auditSigningInvocations([{ file: "scripts/install.sh", source }])).toHaveLength(1);
});
test("a new bare signer fails regardless of its location or invocation API", () => {
  for (const source of [
    'spawn("/usr/bin/codesign", ["--sign", identity, artifact]);',
    'execFile("codesign", ["--sign", identity, artifact]);',
    'codesign --sign "$identity" "$artifact"',
    "security find-identity -v",
    'run("security", ["find-identity", "-v"]);',
    'run("xcrun", ["notarytool", "submit", artifact]);',
  ]) {
    expect(auditSigningInvocations([{ file: "scripts/new-release-leaf.sh", source }])).toHaveLength(
      1,
    );
  }
});

test("only the contributor packager's exact ad-hoc, unnotarized electron-builder argv is exempt", () => {
  const file = "apps/desktop/scripts/package-contributor-macos.ts";
  const call = (flags: string) => `const electronBuilder = [
    "exec",
    "electron-builder",
    "--mac",
    "--dir",
    process.arch === "arm64" ? "--arm64" : "--x64",
    "--config",
    "electron-builder.yml",
    "-c.directories.output=release/contributor",
    ${flags}
  ];`;
  const reviewed = '"-c.mac.identity=-", "-c.mac.notarize=false", "-c.mac.hardenedRuntime=false",';
  expect(auditSigningInvocations([{ file, source: call(reviewed) }])).toEqual([]);
  for (const flags of [
    '"-c.mac.identity=Developer ID Application: Example", "-c.mac.notarize=false", "-c.mac.hardenedRuntime=false",',
    '"-c.mac.identity=-", "-c.mac.identity=Example", "-c.mac.notarize=false", "-c.mac.hardenedRuntime=false",',
    '"-c.mac.identity=-", "-c.mac.hardenedRuntime=false",',
    // Inactive branches must not satisfy the exemption while runtime values sign and notarize.
    'adhoc ? "-c.mac.identity=-" : `-c.mac.identity=${identity}`, adhoc ? "-c.mac.notarize=false" : "-c.mac.notarize=true", "-c.mac.hardenedRuntime=false",',
    `${reviewed} "--publish", "always",`,
  ])
    expect(auditSigningInvocations([{ file, source: call(flags) }])).toHaveLength(1);
  expect(
    auditSigningInvocations([
      { file: "apps/desktop/scripts/other-packager.ts", source: call(reviewed) },
    ]),
  ).toHaveLength(1);
});

test("native sources, package scripts and extensionless build scripts cannot hide a signer", () => {
  for (const fixture of [
    {
      file: "scripts/signing-invocation-guard.ts",
      source: 'spawn("codesign", ["--sign", identity, artifact]);',
    },
    { file: "native/release.c", source: 'system("codesign --sign signer artifact");' },
    {
      file: "tools/package.json",
      source: '{"scripts":{"release":"codesign --sign signer artifact"}}',
    },
    { file: "scripts/release-leaf", source: 'codesign --sign "$identity" "$artifact"' },
  ])
    expect(auditSigningInvocations([fixture])).toHaveLength(1);
});

test("only the update journey's exact ad-hoc fixture signer is credential-free", () => {
  const file = "scripts/public-download/eu-journey.ts";
  const source = 'run("codesign", ["--force", "--deep", "--sign", "-", badApp]);';
  expect(auditSigningInvocations([{ file, source }])).toEqual([]);
  expect(
    auditSigningInvocations([{ file, source: source.replace('"-"', "identity") }]),
  ).toHaveLength(1);
  expect(auditSigningInvocations([{ file: "scripts/other.ts", source }])).toHaveLength(1);
});
