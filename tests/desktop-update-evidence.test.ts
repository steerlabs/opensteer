import { expect, test } from "vitest";
import {
  advertisedVersion,
  rejectionEvidence,
  shutdownEvidence,
} from "../scripts/public-download/evidence.js";

test("negative proof requires complete delivery and the expected native refusal", () => {
  const delivery = {
    at: 12,
    transferComplete: "/fixture.zip",
    bytes: 42,
    size: 42,
    start: 0,
    end: 41,
  };
  const input = {
    kind: "signature",
    delivery,
    expectedBytes: 42,
    messages: ["Squirrel: code signature did not pass validation"],
  };
  expect(rejectionEvidence.parse(input).kind).toBe("signature");
  for (const messages of [
    ["desktop.update.failed"],
    ["checksum mismatch"],
    ["code signature loaded successfully"],
    [
      "Bundle: <private>, key: Code signature at URL %@ did not pass validation, value: , table: Localizable, localizationNames: (null), result: <same as key>",
    ],
    ["truncated transfer"],
    ["ElectronSquirrelPreventDowngrades: appears to be a downgrade"],
  ])
    expect(rejectionEvidence.safeParse({ ...input, messages }).success).toBe(false);
  expect(
    rejectionEvidence.safeParse({ ...input, delivery: { ...delivery, bytes: 41 } }).success,
  ).toBe(false);
  expect(
    rejectionEvidence.safeParse({
      ...input,
      kind: "downgrade",
      messages: ["ElectronSquirrelPreventDowngrades: update appears to be a downgrade"],
    }).success,
  ).toBe(true);
});

test("downgrade metadata is derived above any numeric N+1", () => {
  expect(advertisedVersion("2.9.99", "3.0.0")).toBe("3.0.1");
  expect(() => advertisedVersion("3.0.0", "3.0.0")).toThrow();
  expect(() => advertisedVersion("3.0.1", "3.0.0")).toThrow();
});

test("shutdown proof requires each inventoried exit before an unchanged-bundle witness and swap", () => {
  const input = {
    inventory: [{ pid: 12, command: "postgres" }],
    exits: [{ pid: 12, exitedAt: 2, oldBundleObservedAt: 3 }],
    swapObservedAt: 4,
  };
  expect(shutdownEvidence.safeParse(input).success).toBe(true);
  expect(shutdownEvidence.safeParse({ ...input, exits: [] }).success).toBe(false);
  expect(
    shutdownEvidence.safeParse({
      ...input,
      exits: [{ pid: 12, exitedAt: 4, oldBundleObservedAt: 5 }],
    }).success,
  ).toBe(false);
  expect(
    shutdownEvidence.safeParse({
      ...input,
      exits: [{ pid: 12, exitedAt: 3, oldBundleObservedAt: 2 }],
    }).success,
  ).toBe(false);
});

import { releaseComparison } from "../scripts/public-download/release-comparison.js";
test("CI bridge compares same-commit signing policy and rejects altered helpers", () => {
  const metadata = { expectedTeamId: "ABCDEFGHIJ" };
  const component = {
    path: ".",
    requirement: "designated => anchor apple generic",
    teamId: metadata.expectedTeamId,
    identifier: "com.opensteer.opensteer",
    hardenedRuntime: true,
    entitlements: { "com.apple.security.cs.allow-jit": true },
  };
  const inspection = {
    revision: "a".repeat(40),
    channel: "stable",
    version: "2.0.1",
    bundleVersion: "2.0.1",
    bundleId: component.identifier,
    sha256: "b".repeat(64),
    components: [component, { ...component, path: "Contents/Helpers/tool" }],
    assessment: { status: 0, output: "accepted\nsource=Notarized Developer ID" },
    staple: { status: 0, output: "validated" },
  };
  const input = { metadata, ci: inspection, local: { ...inspection, sha256: "c".repeat(64) } };
  expect(releaseComparison.safeParse(input).success).toBe(true);
  for (const change of [
    { revision: "d".repeat(40) },
    { bundleVersion: "2.0.2" },
    { channel: "beta" },
    { components: [component] },
    { components: [component, { ...component, path: "Contents/Helpers/tool", entitlements: {} }] },
    { components: [{ ...component, teamId: "ZZZZZZZZZZ" }] },
    { components: [{ ...component, hardenedRuntime: false }] },
    { assessment: { status: 0, output: "accepted\nsource=Developer ID" } },
  ])
    expect(
      releaseComparison.safeParse({ ...input, ci: { ...inspection, ...change } }).success,
    ).toBe(false);
});
