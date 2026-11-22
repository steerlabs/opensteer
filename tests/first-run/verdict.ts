import { RemoteAccessHelperUnavailableError } from "../../apps/desktop/src/releases/cloudflared-release.js";

/**
 * What the first-run journey can truthfully reach in the VM, and what fails it. The VM's runtime
 * resources carry no tunnel helper (`cloudflared/release.json`), so the end is the Mac app's own
 * sentence for that, said on the phone step after the account half completed: the Home added to
 * the account, Connect provisioned. Nothing here fakes the helper.
 */

/** The phone step's sentence when the tunnel helper is missing: the Mac app's own words. */
export const helperMissingSentence = new RemoteAccessHelperUnavailableError(null).message;

/** The phone step's sentence when adding this Mac to the account failed: a fail, always. */
const couldNotAdd = /Couldn[’']t add .+ to your account\. Try again\./u;
const alreadyRunning = "Another deployment access operation is already running";
const initializeFailed = "desktop.personal.remote-access.initialize-failed";

export interface FirstRunTrialEvidence {
  /** The phone step's text once it settled. */
  readonly screen: string;
  /** Everything the Mac app wrote to stdout and stderr during the trial. */
  readonly log: string;
  /** Each call the account service made to its tunnel provider. */
  readonly provider: readonly { readonly call: string }[];
  /** The Mac app's own account-link state for this Mac's Home when the trial ended. */
  readonly accountLink: string | null;
}

export interface FirstRunTrialVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly helperSentenceShown: boolean;
  readonly couldNotAddShown: boolean;
  readonly alreadyRunningLogged: number;
  readonly initializeFailedLogged: number;
  readonly connectProvisioned: boolean;
  readonly linked: boolean;
}

export function judgeFirstRunTrial(evidence: FirstRunTrialEvidence): FirstRunTrialVerdict {
  const helperSentenceShown = evidence.screen.includes(helperMissingSentence);
  const couldNotAddShown = couldNotAdd.test(evidence.screen) || couldNotAdd.test(evidence.log);
  const alreadyRunningLogged = occurrences(evidence.log, alreadyRunning);
  const initializeFailedLogged = occurrences(evidence.log, initializeFailed);
  const connectProvisioned = evidence.provider.some(({ call }) => call === "ensure");
  // The account half: the Home was added to the account, with its signed proof.
  const linked = evidence.accountLink === "linked";
  const failures = [
    ...(linked ? [] : [`this Mac's Home is not in the account (link: ${evidence.accountLink})`]),
    ...(helperSentenceShown ? [] : [`the phone step never said: ${helperMissingSentence}`]),
    ...(couldNotAddShown ? ["the phone step said it couldn't add this Mac to the account"] : []),
    ...(alreadyRunningLogged > 0
      ? [`the log says "${alreadyRunning}" ${alreadyRunningLogged} times`]
      : []),
  ];
  return {
    alreadyRunningLogged,
    connectProvisioned,
    couldNotAddShown,
    failures,
    helperSentenceShown,
    initializeFailedLogged,
    linked,
    passed: failures.length === 0,
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** What the Mac app logs when the operating system's protected storage refuses it. */
export const protectedStorageRefused = "desktop.protected-storage.verification-failed";

/**
 * Why a trial stopped at the Mac app's first screen: the keychain screen (macOS refused the app
 * this Mac's keychain, where it keeps its sign-in), or the welcome of a build without an Opensteer
 * account, which has no Sign in. Each says what its log and the guest's default keychain show.
 */
export function firstScreenStopReason(
  screen: "keychain-refused" | "no-account",
  log: string,
  defaultKeychain: string | null = null,
): string {
  const keychain =
    defaultKeychain === null
      ? ""
      : defaultKeychain.includes(fixtureKeychainName)
        ? "; the job's fixture keychain was the default"
        : `; the default keychain was ${defaultKeychain}, not the job's fixture keychain`;
  const logged = log.includes(protectedStorageRefused)
    ? ` (${protectedStorageRefused} in its log)`
    : "";
  return screen === "keychain-refused"
    ? `the Mac app's first screen says it can't use this Mac's keychain, so it has no sign-in to keep${logged}${keychain}`
    : `the Mac app's first screen is the welcome of a build without an Opensteer account: no Sign in${logged}${keychain}`;
}

/** The keychain the VM runner's fixture step puts in place as the default (fixture-keychain.sh). */
export const fixtureKeychainName = "opensteer-journey-fixture.keychain-db";

/** A trial that stopped before the phone step: failed, with the reason and what its log shows. */
export function stoppedTrial(reason: string, log: string): FirstRunTrialVerdict {
  const verdict = judgeFirstRunTrial({ accountLink: null, log, provider: [], screen: "" });
  // Of the judgement, only what the log says: the screen and the link were never reached.
  const fromLog = verdict.failures.filter(
    (failure) =>
      !failure.startsWith("this Mac's Home is not") && !failure.startsWith("the phone step never"),
  );
  return { ...verdict, failures: [`the trial stopped: ${reason}`, ...fromLog] };
}
