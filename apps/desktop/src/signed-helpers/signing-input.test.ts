import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { parseSigningInput, resolveSigningMode, generatedSigningConstants } =
  require("../../scripts/signing-input.cjs") as typeof import("../../scripts/signing-input.cjs");
const fixture = {
  teamId: "ABCDE12345",
  identity: "Developer ID Application: Example (ABCDE12345)",
};
// Failures: malformed/injected team or identity, mismatched certificate team, empty
// notary profile, missing authority, accidental development release, divergent outputs.
describe("desktop signing input", () => {
  it("validates the identity and optional notarization profile", () => {
    expect(parseSigningInput(fixture)).toEqual(fixture);
    expect(
      parseSigningInput({ ...fixture, notarizationProfile: "contributor" }).notarizationProfile,
    ).toBe("contributor");
    for (const invalid of [
      null,
      {},
      { ...fixture, teamId: "bad" },
      { ...fixture, identity: "-" },
      { ...fixture, identity: "Developer ID Application: Other (ZZZZZ12345)" },
      { ...fixture, notarizationProfile: "" },
      { ...fixture, extra: true },
    ]) {
      expect(() => parseSigningInput(invalid)).toThrow();
    }
  });
  it("defaults ordinary builds to development and requires input only for release", () => {
    expect(resolveSigningMode()).toEqual({ mode: "development" });
    expect(resolveSigningMode({ distributable: false })).toEqual({ mode: "development" });
    expect(() => resolveSigningMode({ distributable: true })).toThrow();
    expect(() => resolveSigningMode({ signing: { ...fixture, teamId: "bad" } })).toThrow();
    expect(resolveSigningMode({ signing: fixture })).toEqual({ mode: "signed", signing: fixture });
    expect(resolveSigningMode({ signing: fixture, distributable: true })).toEqual({
      mode: "signed",
      signing: fixture,
    });
    const release = generatedSigningConstants({ signing: fixture, distributable: true });
    expect(release.typescript).toContain("developmentTrust = false");
    expect(release.typescript).not.toContain("developmentTrust = true");
  });
  it("generates TS and build constants from the same validated input", () => {
    const output = generatedSigningConstants({ signing: fixture });
    expect(output.typescript).toContain(fixture.teamId);
    expect(output.build).toEqual(fixture);
    const other = generatedSigningConstants({
      signing: { teamId: "ZZZZZ12345", identity: "Developer ID Application: Other (ZZZZZ12345)" },
    });
    expect(other.typescript).not.toContain(fixture.teamId);
  });
});

it("refuses a missing signing file even with development trust requested", () => {
  const { readSigningMode } =
    require("../../scripts/signing-input.cjs") as typeof import("../../scripts/signing-input.cjs");
  expect(() =>
    readSigningMode({
      OPENSTEER_DESKTOP_SIGNING_FILE: "/missing/signing.json",
      OPENSTEER_DESKTOP_DEVELOPMENT_TRUST: "1",
    }),
  ).toThrow();
  expect(() => readSigningMode({ OPENSTEER_DESKTOP_RELEASE: "1" })).toThrow();
});

it("accepts complete CI authority and rejects partial or mismatched signing inputs", () => {
  const { readSigningMode } =
    require("../../scripts/signing-input.cjs") as typeof import("../../scripts/signing-input.cjs");
  const environment = {
    OPENSTEER_DESKTOP_RELEASE: "1",
    OPENSTEER_RELEASE_SIGNING_IDENTITY: fixture.identity,
    OPENSTEER_APPLE_TEAM_ID: fixture.teamId,
  };
  expect(readSigningMode(environment)).toEqual({ mode: "signed", signing: fixture });
  expect(() => readSigningMode({ ...environment, OPENSTEER_APPLE_TEAM_ID: undefined })).toThrow();
  expect(() =>
    readSigningMode({ ...environment, OPENSTEER_APPLE_TEAM_ID: "ZZZZZ12345" }),
  ).toThrow();
});
