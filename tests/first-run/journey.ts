/**
 * The first-run journey (VM only: `pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh
 * first-run`). It runs the real account service code on a PostgreSQL of its own and the Mac app
 * pointed at it, and drives the app's own screens the way a person does: Sign in → "Where should
 * your Opensteer live?" → On this Mac → the setup steps → "Connect your phone", where the app turns
 * Remote access on by itself.
 *
 * Real: the account service (config, sign-in, consent, tokens, the account-link challenge and its
 * completion with the Home's signed proof, the directory, Connect provisioning), the Mac app, and
 * the Home it sets up. Stand-ins: the tunnel provider (`MemoryConnectProvider`), the system browser
 * (`signInAtAccount`, which fills in the account's own App Review sign-in form), and macOS handing
 * the app its callback address (`open-url`, as macOS sends it).
 *
 * Unverified here, always: a real tunnel that a phone outside can reach. The VM's runtime carries no
 * tunnel helper and the stand-in provider's token starts no connector, so each trial ends at the
 * Mac app's own sentence for a missing helper, after the account half has completed.
 *
 * Two trials: `settled` waits for this Mac's Home to be ready before moving through setup;
 * `racing` moves on as soon as each step appears, so the turn-on arrives while the Home is still
 * being set up, as it did on the walk that found "Another deployment access operation is already
 * running".
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import {
  journeyAccount,
  startJourneyAccountService,
  startJourneyPostgres,
} from "./account-service.js";
import { signInAtAccount } from "./browser.js";
import {
  accountLinkStatus,
  emitOpenUrl,
  homeIsReady,
  nextKnownSetupStep,
  phoneStepSettled,
  quitApp,
} from "./remote.js";
import { journeyAccountTls, type JourneyAccountTls } from "./account-tls.js";
import { journeyAppEnvironment } from "./app-environment.js";
import { phoneStepTitle, setupMoves } from "./setup-walk.js";
import { openedByPress, type ElectronAppCalls } from "./system-browser.js";
import { desktopFirstScreenWords } from "../../apps/web/src/components/places/desktop-first-screen-words.js";
import {
  firstScreenOf,
  type DesktopFirstScreen,
} from "../../apps/web/src/components/places/desktop-first-screen.test-support.js";
import {
  helperMissingSentence,
  judgeFirstRunTrial,
  firstScreenStopReason,
  stoppedTrial,
  type FirstRunTrialVerdict,
} from "./verdict.js";

type Trial = "settled" | "racing";
const trials: readonly Trial[] = ["settled", "racing"];
const desktop = path.resolve(import.meta.dirname, "../../apps/desktop");
const out = path.resolve(required("OPENSTEER_JOURNEY_OUT"));
const resources = path.resolve(required("OPENSTEER_PERSONAL_E2E_RESOURCES"));
const runtime = path.join(resources, "personal-runtime");
const settleMs = 3 * 60_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required: run this journey with pnpm test:vm.`);
  return value;
}

// The Host takes only a bare public HTTPS origin as its issuer: the account service is served
// under the guest's fixture name with the fixture authority's certificate (`account-tls.ts`).
const accountTls = requiredAccountTls();

function requiredAccountTls(): JourneyAccountTls {
  const tls = journeyAccountTls();
  if (tls === null)
    throw new Error(
      "No fixture authority in this guest: scripts/test-vm/fixture-keychain.sh makes it at the job's start.",
    );
  return tls;
}

const postgres = await startJourneyPostgres({
  binDirectory: path.join(runtime, "postgres", "bin"),
  dataDirectory: path.join(await mkdtemp(path.join(tmpdir(), "account-")), "postgres"),
});
const results: { trial: Trial; verdict: FirstRunTrialVerdict }[] = [];
try {
  for (const trial of trials) results.push({ trial, verdict: await runTrial(trial) });
} finally {
  await postgres.stop();
}
for (const { trial, verdict } of results) {
  console.log(
    `first-run ${trial}: ${verdict.passed ? "PASS" : "FAIL"} · linked ${verdict.linked} · ` +
      `helper sentence ${verdict.helperSentenceShown} · Connect provisioned ${verdict.connectProvisioned} · ` +
      `initialize-failed ×${verdict.initializeFailedLogged} · already running ×${verdict.alreadyRunningLogged}`,
  );
  for (const failure of verdict.failures) console.log(`  ✗ ${failure}`);
}
console.log(
  "first-run unverified: a real tunnel a phone outside can reach (no tunnel helper, no Cloudflare)",
);
process.exitCode = results.every(({ verdict }) => verdict.passed) ? 0 : 1;

async function runTrial(trial: Trial): Promise<FirstRunTrialVerdict> {
  const directory = path.join(out, trial);
  await mkdir(directory, { recursive: true });
  // The Mac app's data, and the Home's own PostgreSQL socket inside it, under the journey's short
  // temporary directory: a socket path is limited to 104 bytes.
  const data = await mkdtemp(path.join(tmpdir(), `${trial}-`));
  const account = await startJourneyAccountService({
    databaseUrl: await postgres.database(`first_run_${trial}`),
    tls: accountTls,
  });
  const log: string[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [desktop],
      cwd: desktop,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...journeyAppEnvironment({
          accountOrigin: account.origin,
          dataDirectory: data,
          extraCertificateAuthorities: accountTls.authorityFile,
          portalOrigin: account.portalOrigin,
          runtime,
        }),
      },
      executablePath: createRequire(path.join(desktop, "package.json"))("electron") as string,
    });
    app.process().stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString("utf8")));
    app.process().stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString("utf8")));
    const page = await app.firstWindow();
    // The first screen decides whether there is an account to sign in to at all.
    await firstScreen(page, log, directory);
    await signIn(app, page, account.origin);
    await screen(page, desktopFirstScreenWords.whereTitle);
    // The row's name is its title and its detail: it starts with the title.
    await page
      .getByRole("button", {
        name: new RegExp(`^${escaped(desktopFirstScreenWords.onThisMac)}`, "u"),
      })
      .click();
    if (trial === "settled") await homeReady(page);
    await skipToPhoneStep(page);
    const shown = await phoneStepSettles(page);
    await page.screenshot({ path: path.join(directory, "phone-step.png") });
    const accountLink = await page.evaluate(accountLinkStatus);
    const verdict = judgeFirstRunTrial({
      accountLink,
      log: log.join(""),
      provider: account.provider.calls,
      screen: shown,
    });
    await writeFile(path.join(directory, "phone-step.txt"), shown);
    await writeFile(path.join(directory, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
    await writeFile(
      path.join(directory, "provider-calls.json"),
      JSON.stringify(account.provider.calls, null, 2) + "\n",
    );
    return verdict;
  } catch (error) {
    // Whatever stopped the trial is its result, with the screen it stopped on: never a crash
    // that hides it.
    const reason = error instanceof Error ? error.message : String(error);
    await writeFile(path.join(directory, "stopped.txt"), `${reason}\n`);
    const page = app?.windows()[0];
    if (page) {
      await page.screenshot({ path: path.join(directory, "stopped.png") }).catch(() => undefined);
      const text = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      await writeFile(path.join(directory, "stopped-screen.txt"), text);
    }
    const verdict = stoppedTrial(reason, log.join(""));
    await writeFile(path.join(directory, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
    return verdict;
  } finally {
    await writeFile(path.join(directory, "app.log"), log.join(""));
    if (app) await quit(app);
    await account.close();
  }
}

/**
 * The Mac app's first screen, decided by what only that screen shows (`firstScreenOf`, in the
 * product's own words): Sign in goes on; the keychain screen and the welcome of a build without an
 * account stop the trial, each with its own reason.
 */
async function firstScreen(page: Page, log: readonly string[], directory: string): Promise<void> {
  const shown = (await (
    await page.waitForFunction(firstScreenOf, desktopFirstScreenWords, {
      polling: 250,
      timeout: settleMs,
    })
  ).jsonValue()) as DesktopFirstScreen;
  if (shown === "sign-in") return;
  // Which keychain the guest's session used: the evidence for why, read only.
  const keychain = defaultKeychain();
  await writeFile(path.join(directory, "default-keychain.txt"), `${keychain ?? "unknown"}\n`);
  throw new Error(firstScreenStopReason(shown, log.join(""), keychain));
}

/** The user's default keychain, as `security` names it; null where it can't say. */
function defaultKeychain(): string | null {
  try {
    return execFileSync("/usr/bin/security", ["default-keychain", "-d", "user"], {
      encoding: "utf8",
    })
      .trim()
      .replace(/^"|"$/gu, "");
  } catch {
    return null;
  }
}

/** Sign in, through the account service's own pages, and hand the app its callback. */
async function signIn(app: ElectronApplication, page: Page, accountOrigin: string): Promise<void> {
  // The system browser: the address the app opens on Sign in comes back as an event.
  const authorizeUrl = await openedByPress(
    app as unknown as ElectronAppCalls,
    `${accountOrigin}/api/auth/oauth2/authorize`,
    () => page.getByRole("button", { name: "Sign in", exact: true }).click(),
    settleMs,
  );
  const { callback } = await signInAtAccount({
    authorizeUrl,
    email: journeyAccount.email,
    password: journeyAccount.password,
    tls: { ca: accountTls.ca },
  });
  // macOS hands an app the address of a scheme it registered as an `open-url` event.
  await app.evaluate(emitOpenUrl, callback);
}

/** This Mac's Home is set up and attached: what `settled` waits for before moving on. */
async function homeReady(page: Page): Promise<void> {
  await page.waitForFunction(homeIsReady, undefined, { polling: 250, timeout: settleMs });
}

/** Through the setup steps, as soon as each appears, to "Connect your phone". */
async function skipToPhoneStep(page: Page): Promise<void> {
  let previous: string | null = null;
  for (let step = 0; step < 6; step += 1) {
    const title = await nextSetupStep(page, previous);
    if (title === phoneStepTitle) return;
    const move = setupMoves[title];
    if (move === undefined) throw new Error(`the setup walk has no move for "${title}"`);
    await page.getByRole("button", { name: move, exact: true }).click();
    previous = title;
  }
  throw new Error(`the setup steps never reached "${phoneStepTitle}"`);
}

/** The title of the next setup step the walk knows, once it differs from the one just passed. */
async function nextSetupStep(page: Page, previous: string | null): Promise<string> {
  const known = [...Object.keys(setupMoves), phoneStepTitle];
  try {
    const handle = await page.waitForFunction(
      nextKnownSetupStep,
      { known, previous },
      { polling: 250, timeout: settleMs },
    );
    return (await handle.jsonValue()) as string;
  } catch {
    // Say where it stood: a step whose title or move changed reads as that, not as a timeout.
    const showing = await page
      .locator(".setup-frame__title")
      .first()
      .innerText()
      .catch(() => "no setup step");
    throw new Error(
      previous === null
        ? `the setup walk found no step it knows; the screen shows "${showing}"`
        : `the setup walk stayed after "${previous}"; the screen shows "${showing}"`,
    );
  }
}

/** The phone step's text once the turn-on has come to its end: the helper sentence, or a failure. */
async function phoneStepSettles(page: Page): Promise<string> {
  await page
    .waitForFunction(phoneStepSettled, helperMissingSentence, { timeout: settleMs })
    // Judged on what it shows: a turn-on that never ends fails on the missing sentence.
    .catch(() => undefined);
  return page.locator("body").innerText();
}

async function screen(page: Page, words: string): Promise<void> {
  await page.getByText(words, { exact: true }).waitFor({ timeout: settleMs });
}

/** Product words as a pattern that means exactly those words. */
function escaped(words: string): string {
  return words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** A step that never comes fails the trial instead of holding the run until the VM's own limit. */
function bounded<T>(promise: Promise<T>, what: string, ms = settleMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      // oxlint-disable-next-line opensteer/no-real-time-wait-in-tests -- A bound on a step the app owns, not a wait: it only ever fails the trial.
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Quit as the app quits; stop it by its own PID only if it doesn't. */
async function quit(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await app.evaluate(quitApp).catch(() => undefined);
  const quitInTime = await bounded(exited, "the app to quit", 30_000).then(
    () => true,
    () => false,
  );
  if (!quitInTime && child.pid !== undefined) {
    process.kill(child.pid, "SIGTERM");
    await exited;
  }
}
