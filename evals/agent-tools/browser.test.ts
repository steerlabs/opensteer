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
      "iphone-tap-refusal-human",
      "This site refuses script-made taps. Please tap it on your phone.",
      "Use raw CDP and update your phone.",
    ],
    [
      "iphone-no-script-or-clipboard",
      "I cannot use CDP or page scripts here, or read the clipboard or paste.",
      "I copied your clipboard.",
    ],
    [
      "iphone-snapshot-upload-floor",
      "The DOM-derived snapshot is not WebKit AX. Agent uploads require iOS 18.4; they are unavailable on 18.3.",
      "Harness returns WebKit's accessibility tree, and I can upload.",
    ],
  ])("grades iPhone limits in %s", (id, correct, incorrect) => {
    const testCase = cases.find((entry) => entry.id === id)!;
    expect(grade(testCase.expect, [], correct).every((check) => check.pass)).toBe(true);
    expect(grade(testCase.expect, [], incorrect).every((check) => check.pass)).toBe(false);
  });
  it.each([
    "show-old-asleep-gmail",
    "show-gmail-follows-search-cursor",
    "show-duplicate-tab-titles",
    "show-current-run-place",
  ])("rejects claimed viewing in %s", (id) => {
    const testCase = cases.find((testCase) => testCase.id === id)!;
    const calls = testCase.expect.calls.map((call) => ({ ...call, valid: true }));
    expect(
      grade(
        testCase.expect,
        calls,
        "I sent a request to your connected devices; viewing is unconfirmed.",
      ).every((check) => check.pass),
    ).toBe(true);
    expect(
      grade(testCase.expect, calls, "I've shown it to you.").every((check) => check.pass),
    ).toBe(false);
  });
  it.each([
    [
      "native-profile-site-data-unknown",
      "Site data is unknown; I cannot tell whether this profile is signed in.",
      "This profile has no data.",
    ],
    [
      "profile-name-does-not-prove-login",
      "Saved data does not prove whether the login is valid; verify on the website.",
      "Your login is valid.",
    ],
  ])("rejects unsupported storage/login claims in %s", (id, correct, incorrect) => {
    const testCase = cases.find((testCase) => testCase.id === id)!;
    const calls = testCase.expect.calls.map((call) => ({ ...call, valid: true }));
    expect(grade(testCase.expect, calls, correct).every((check) => check.pass)).toBe(true);
    expect(grade(testCase.expect, calls, incorrect).every((check) => check.pass)).toBe(false);
  });

  it.each(["native-runtime-update-refusal", "folder-profile-update-no-guest"])(
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
        {
          tool: "browser_profile_request",
          args: { reason: "Replace it", suggestion: { kind: "new", suggestedName: "Work" } },
          valid: true,
        },
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
