import { describe, expect, it } from "vitest";
import { pageForm } from "./browser.js";
import {
  helperMissingSentence,
  judgeFirstRunTrial,
  noAccountReason,
  stoppedTrial,
} from "./verdict.js";

/*
 * The first-run journey's own judgement, without the VM: what passes it, what fails it, and what
 * it records. The journey itself runs only in the VM.
 */

const passing = {
  accountLink: "linked",
  log: [
    '{"event":"desktop.personal.remote-access.initialize-failed","message":"x"}',
    '{"event":"desktop.personal.remote-access.initialize-failed","message":"x"}',
  ].join("\n"),
  provider: [{ call: "ensure" }],
  screen: `Connect your phone\n${helperMissingSentence}\nSkip for now`,
};

describe("the first-run journey's verdict", () => {
  it("passes on the helper sentence once the Home is in the account, and records what it saw", () => {
    expect(judgeFirstRunTrial(passing)).toEqual({
      alreadyRunningLogged: 0,
      connectProvisioned: true,
      couldNotAddShown: false,
      failures: [],
      helperSentenceShown: true,
      initializeFailedLogged: 2,
      linked: true,
      passed: true,
    });
  });

  it("says the Mac app's own sentence for a missing helper, word for word", () => {
    expect(helperMissingSentence).toBe(
      "Remote access can’t start because part of Opensteer is missing or damaged on this Mac. Reinstall Opensteer, then turn it on again.",
    );
  });

  it("fails on Couldn't add, on the screen or in the log", () => {
    for (const evidence of [
      {
        ...passing,
        screen: `${passing.screen}\nCouldn’t add Studio Mac to your account. Try again.`,
      },
      { ...passing, log: `${passing.log}\nCouldn't add Studio Mac to your account. Try again.` },
    ]) {
      const verdict = judgeFirstRunTrial(evidence);
      expect(verdict.passed).toBe(false);
      expect(verdict.couldNotAddShown).toBe(true);
    }
  });

  it("fails on already running anywhere in the log, and counts it", () => {
    const verdict = judgeFirstRunTrial({
      ...passing,
      log: `${passing.log}\nError occurred in handler for 'opensteer.desktop.access.link-personal': Error: Another deployment access operation is already running.`,
    });
    expect(verdict).toMatchObject({ alreadyRunningLogged: 1, passed: false });
  });

  it("fails when the Home never reached the account, whatever the screen says", () => {
    expect(judgeFirstRunTrial({ ...passing, accountLink: "unlinked" })).toMatchObject({
      linked: false,
      passed: false,
    });
  });

  it("fails when the phone step never said why Remote access didn't start", () => {
    expect(
      judgeFirstRunTrial({ ...passing, screen: "Connect your phone\nTurning on…" }),
    ).toMatchObject({ helperSentenceShown: false, passed: false });
  });
});

describe("the browser stand-in's reading of a page's form", () => {
  it("finds the form by where it posts and carries its hidden fields as a browser would", () => {
    const page = {
      html: `<form method="post" action="/sign-in/google"><input type="hidden" name="oauth_query" value="wrong"></form>
<form class="form" method="post" action="/sign-in/app-review"><input type="hidden" name="oauth_query" value="client_id=desktop&amp;state=s&amp;sig=a%2Bb"><input type="email" name="email"></form>`,
      url: new URL("http://127.0.0.1:4142/sign-in?x=1"),
    };
    const form = pageForm(page, "/sign-in/app-review");
    expect(form.action.toString()).toBe("http://127.0.0.1:4142/sign-in/app-review");
    expect([...form.fields]).toEqual([["oauth_query", "client_id=desktop&state=s&sig=a%2Bb"]]);
    expect(() => pageForm(page, "/consent")).toThrow("/sign-in has no form that posts to /consent");
  });
});

describe("a trial that stops before the phone step", () => {
  const refused =
    '{"event":"desktop.protected-storage.verification-failed","message":"encrypt: Error while encrypting the text provided to safeStorage.encryptStringAsync."}';

  it("says the first screen had no account, and why when the log says protected storage refused", () => {
    expect(noAccountReason(refused)).toBe(
      "the Mac app's first screen has no account to sign in to: macOS protected storage refused it " +
        "(desktop.protected-storage.verification-failed in its log), so its sign-in and this Mac's Home cannot keep their secrets in this guest",
    );
    expect(noAccountReason("")).toBe("the Mac app's first screen has no account to sign in to");
  });

  it("fails with its reason first and keeps what its log shows, never a pass", () => {
    const verdict = stoppedTrial(
      "Timed out waiting for the phone step",
      [
        refused,
        '{"event":"desktop.personal.remote-access.initialize-failed","message":"x"}',
        "Error: Another deployment access operation is already running.",
      ].join("\n"),
    );
    expect(verdict).toMatchObject({
      alreadyRunningLogged: 1,
      initializeFailedLogged: 1,
      linked: false,
      passed: false,
    });
    expect(verdict.failures).toEqual([
      "the trial stopped: Timed out waiting for the phone step",
      'the log says "Another deployment access operation is already running" 1 times',
    ]);
  });
});
