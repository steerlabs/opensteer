import { describe, expect, it } from "vitest";
import { browserSignInProblemCopy, browserSiteLabel } from "./browser-sign-in.js";
import { passwordSavePrompt } from "./password-save.js";
import { chromeCookiesStep, savedLoginStep } from "./passwords.js";
import { saidWords, type SaidPart } from "./said.js";

/*
 * Signing in to a site and saving a password for it are where a person decides something about
 * the site (F14). Their words are made with the site as an address slot (`said.ts`, F17): a
 * client draws it as an address in its sentence, and a name someone chose (a Chrome profile's) is
 * a name, never taken for an address however it reads.
 */

const site = "https://accounts.studio-mac-mini.fixture.invalid";
const domain = browserSiteLabel(site);
const problems = [
  "no-chrome",
  "chrome-offline",
  "choose-source",
  "session-closed",
  "runtime-outdated",
  "unsupported-operation",
  "no-state",
  "stopped",
  "chrome-blocked",
  "limit",
  "not-allowed",
  "site-removed",
  "unsupported",
  "too-large",
] as const;

/** The parts read as the words, and the site is in them only as an address. */
function expectMade(text: string | null, parts: readonly SaidPart[] | null) {
  if (text === null) return expect(parts).toBeNull();
  expect(parts!.map(saidWords).join("")).toBe(text);
  expect(parts!.filter((part) => typeof part === "string" && part.includes(domain))).toEqual([]);
  expect(parts!.some((part) => typeof part === "object" && "address" in part)).toBe(
    text.includes(domain),
  );
}

describe("the words of signing in to a site and saving its password", () => {
  for (const problem of problems)
    for (const context of ["browser", "request", "page"] as const)
      for (const sourceName of [null, "evil.example"])
        it(`make the site an address, for ${problem} in a ${context} (${sourceName ?? "no name"})`, () => {
          const copy = browserSignInProblemCopy(problem as never, { context, site, sourceName });
          expectMade(copy.title, copy.titleParts);
          expectMade(copy.fix, copy.fixParts);
          // A Chrome profile named like a host is a name.
          for (const part of [...copy.titleParts, ...(copy.fixParts ?? [])])
            if (typeof part === "object" && "address" in part) expect(part.address).toBe(domain);
        });

  it("make it an address in each step of a sign-in, and the account too", () => {
    for (const step of [
      savedLoginStep({ account: "person@fixture.invalid", site, status: "ready" } as never),
      savedLoginStep({ site, status: "pending" } as never),
      savedLoginStep({ reason: "no-saved-login", site, status: "unavailable" } as never),
      chromeCookiesStep({ profileName: null, site, sourceName: "Work", status: "copied" } as never),
      chromeCookiesStep({ reason: "chrome-signed-out", site, status: "unavailable" } as never),
    ]) {
      expectMade(step.label, step.labelParts);
      expect(step.hintParts.map(saidWords).join("")).toBe(step.hint);
    }
    expect(
      savedLoginStep({ account: "person@fixture.invalid", site, status: "ready" } as never)
        .hintParts,
    ).toEqual(["As ", { address: "person@fixture.invalid" }]);
  });

  it("make it an address in the offer to save a password", () => {
    const prompt = passwordSavePrompt({
      kind: "save",
      origin: site,
      username: "person@fixture.invalid",
    } as never);
    expectMade(prompt.title, prompt.titleParts);
    expect(prompt.title).toContain(domain);
  });
});
