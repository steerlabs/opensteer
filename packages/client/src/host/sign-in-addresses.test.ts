import { describe, expect, it } from "vitest";
import { browserSignInProblemCopy, browserSiteLabel } from "./browser-sign-in.js";
import { passwordSavePrompt } from "./password-save.js";
import { chromeCookiesStep, savedLoginStep } from "./passwords.js";

/*
 * Signing in to a site and saving a password for it are where a person decides something about
 * the site: the words that name it say which addresses they hold, so a client draws each as an
 * address inside its sentence (F14; rule 4 of `tests/mobile-address-text.test.ts`).
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

/** Each word that holds the site's domain says so, and says nothing it does not hold. */
function expectSaid(words: readonly (string | null)[], addresses: readonly string[]) {
  const holds = words.some((word) => word?.includes(domain) === true);
  expect(addresses, words.join(" / ")).toEqual(holds ? [domain] : []);
}

describe("the words of signing in to a site and saving its password", () => {
  for (const problem of problems)
    for (const context of ["browser", "request", "page"] as const)
      for (const sourceName of [null, "Work"])
        it(`say the site they name, for ${problem} in a ${context} (${sourceName ?? "no name"})`, () => {
          const copy = browserSignInProblemCopy(problem as never, { context, site, sourceName });
          expectSaid([copy.title, copy.fix], copy.addresses);
        });

  it("say it in each step of a sign-in", () => {
    for (const step of [
      savedLoginStep({ account: "person@fixture.invalid", site, status: "ready" } as never),
      savedLoginStep({ site, status: "pending" } as never),
      savedLoginStep({ reason: "no-saved-login", site, status: "unavailable" } as never),
      chromeCookiesStep({ profileName: null, site, sourceName: "Work", status: "copied" } as never),
      chromeCookiesStep({ reason: "chrome-signed-out", site, status: "unavailable" } as never),
    ]) {
      for (const address of step.addresses) expect(`${step.label} ${step.hint}`).toContain(address);
      expect(step.addresses).toContain(domain);
    }
    expect(
      savedLoginStep({ account: "person@fixture.invalid", site, status: "ready" } as never)
        .addresses,
    ).toEqual([domain, "person@fixture.invalid"]);
  });

  it("say it in the offer to save a password", () => {
    const prompt = passwordSavePrompt({
      kind: "save",
      origin: site,
      username: "person@fixture.invalid",
    } as never);
    expect(prompt.title).toContain(domain);
    expect(prompt.addresses).toEqual([domain]);
  });
});
