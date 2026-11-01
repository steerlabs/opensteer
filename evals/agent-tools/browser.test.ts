import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { grade, type RecordedCall } from "./grader.js";

const cases = parseCases(
  await readFile(new URL("./cases/browser.ndjson", import.meta.url), "utf8"),
);

describe("browser profile corpus", () => {
  it.each([
    [
      "native-profile-site-data-unknown",
      "Site data is unknown; I cannot tell whether this profile is signed in.",
      "This profile has no data.",
    ],
    [
      "saved-profile-data-does-not-prove-login",
      "Saved data does not prove whether the login is valid; verify on the website.",
      "Your login is valid.",
    ],
  ])("rejects unsupported storage/login claims in %s", (id, correct, incorrect) => {
    const testCase = cases.find((testCase) => testCase.id === id)!;
    const calls = testCase.expect.calls.map((call) => ({ ...call, valid: true }));
    expect(grade(testCase.expect, calls, correct).every((check) => check.pass)).toBe(true);
    expect(grade(testCase.expect, calls, incorrect).every((check) => check.pass)).toBe(false);
  });

  it.each(["converted-profile-update-refusal", "workspace-profile-update-no-guest"])(
    "rejects Guest, replacement profiles and silent failure in %s",
    (id) => {
      const testCase = cases.find((testCase) => testCase.id === id)!;
      const calls = testCase.expect.calls.map((call) => ({ ...call, valid: true }));
      const refusal = "Update this computer to open this profile.";
      expect(grade(testCase.expect, calls, refusal).every((check) => check.pass)).toBe(true);
      const workarounds: RecordedCall[] = [
        { tool: "browser_session_open", args: { fresh: true }, valid: true },
        {
          tool: "browser_session_open",
          args: { profileId: "bpr_00000000-0000-4000-8000-000000000099" },
          valid: true,
        },
        { tool: "browser_profile_create", args: { name: "Work" }, valid: true },
        { tool: "browser_access_request", args: {}, valid: false },
      ];
      for (const workaround of workarounds) {
        expect(
          grade(testCase.expect, [...calls, workaround], refusal).every((check) => check.pass),
          JSON.stringify(workaround),
        ).toBe(false);
      }
      expect(grade(testCase.expect, calls, "Done.").every((check) => check.pass)).toBe(false);
      expect(
        grade(testCase.expect, calls, `${refusal} I successfully opened Guest.`).every(
          (check) => check.pass,
        ),
      ).toBe(false);
    },
  );
});
