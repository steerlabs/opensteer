import { expect, test } from "vitest";
import {
  advertisedVersion,
  rejectionEvidence,
  shutdownEvidence,
  updateFailures,
  journeyInput,
} from "../scripts/public-download/evidence.js";

test("negative proof requires complete delivery followed by the matching classified refusal", () => {
  const delivery = {
    at: 12,
    transferComplete: "/fixture.zip",
    bytes: 42,
    size: 42,
    start: 0,
    end: 41,
  };
  const failure = { at: 13, event: "desktop.update.failed", reason: "signature" };
  const input = { kind: "signature", delivery, expectedBytes: 42, failure };
  expect(rejectionEvidence.parse(input).kind).toBe("signature");
  for (const reason of ["other", "downgrade", undefined, "checksum mismatch"])
    expect(rejectionEvidence.safeParse({ ...input, failure: { ...failure, reason } }).success).toBe(
      false,
    );
  expect(rejectionEvidence.safeParse({ ...input, failure: { ...failure, at: 11 } }).success).toBe(
    false,
  );
  expect(
    rejectionEvidence.safeParse({ ...input, delivery: { ...delivery, bytes: 41 } }).success,
  ).toBe(false);
  expect(
    rejectionEvidence.safeParse({
      ...input,
      kind: "downgrade",
      failure: { ...failure, reason: "downgrade" },
    }).success,
  ).toBe(true);
});

test("desktop failure parsing requires the classified hook and preserves its event time", () => {
  expect(
    updateFailures(
      '2026-10-30T01:00:00.000Z stdout {"event":"desktop.update.failed","reason":"signature"}',
    ),
  ).toEqual([
    {
      at: Date.parse("2026-10-30T01:00:00.000Z"),
      event: "desktop.update.failed",
      reason: "signature",
    },
  ]);
  expect(() =>
    updateFailures('2026-10-30T01:00:00.000Z stdout {"event":"desktop.update.failed"}'),
  ).toThrow();
  expect(
    updateFailures('2026-10-30T01:00:00.000Z stdout {"event":"desktop.update.checking"}'),
  ).toEqual([]);
});

test("fixtures must be genuinely older than N and recovery must advance N", () => {
  const release = (version: string) => ({ version, revision: "a".repeat(40) });
  const input = { older: release("0.1.219"), n: release("0.1.252"), next: release("0.1.253") };
  expect(journeyInput.safeParse(input).success).toBe(true);
  expect(journeyInput.safeParse({ ...input, older: input.n }).success).toBe(false);
  expect(journeyInput.safeParse({ ...input, next: input.n }).success).toBe(false);
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
