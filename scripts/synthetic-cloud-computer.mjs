#!/usr/bin/env node
// The synthetic purchase: one person's whole Cloud Computer path, end to end, against an
// Opensteer account service selling in Stripe TEST mode, so a broken purchase is found before a
// person finds it (deploy/monitoring/policies/page-synthetic-failed-twice.yaml).
//
//   1. sign in with the synthetic purchase's OWN account (the account service's
//      OPENSTEER_SYNTHETIC_SIGN_IN_EMAIL; never App Review's)
//   2. delete any Cloud Computer an earlier run left in that account, and wait until it is gone
//   3. check out, and pay on Stripe's own hosted Checkout page in a headless Chromium, with
//      Stripe's test card 4242 4242 4242 4242
//   4. wait, within a bound, for the Cloud Computer to be ready
//   5. open its address and check the Home answers as the one the account claimed
//   6. delete it (which cancels its subscription) and wait until the machine and its DNS name
//      are gone; this runs whatever happened before, and is itself checked
//
// What it proves: the account's checkout, Stripe's hosted page taking a test card, the webhook
// or the 60-second pass turning a payment into a Cloud Computer, the provisioner making a real VM,
// the Home's set-up and claim, and deletion with its VM and DNS name gone. What it does not prove:
// live-mode Stripe (it refuses a session that is not `cs_test_`), a real card, or renewal.
//
// It only ever acts in its own account, and only on Cloud Computers it made or an earlier run
// left there. It writes one JSON line, `synthetic.run.passed`, or `synthetic.run.failed` with the
// failed step, and exits with that step's code.
//
// Configuration (each also as <NAME>_FILE):
//   OPENSTEER_SYNTHETIC_ACCOUNT_URL       https origin of the account service
//   OPENSTEER_SYNTHETIC_EMAIL             its synthetic sign-in (OPENSTEER_SYNTHETIC_SIGN_IN_EMAIL)
//   OPENSTEER_SYNTHETIC_PASSWORD          and password
//   OPENSTEER_SYNTHETIC_READY_MINUTES     bound for step 4 (default 30)
//   OPENSTEER_SYNTHETIC_GONE_MINUTES      bound for steps 2 and 6 (default 20)
//   OPENSTEER_SYNTHETIC_HEARTBEAT_URL     optional: a GET after a passing run
//
// It needs Node 22 or later and playwright-core 1.62.1 with its Chromium (the repository has
// both; deploy/monitoring/synthetic-cronjob.yaml runs it in Playwright's own image).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve4, resolve6 } from "node:dns/promises";
import { pathToFileURL } from "node:url";

/** Each step's exit code; the JSON line names the step. */
export const steps = {
  configuration: 2,
  "sign-in": 10,
  leftover: 11,
  checkout: 12,
  payment: 13,
  ready: 14,
  home: 15,
  delete: 16,
  gone: 17,
};

export class StepFailed extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
    this.detail = detail;
  }
}

const fail = (step, detail) => {
  throw new StepFailed(step, detail);
};

export function readConfiguration(env = process.env) {
  const value = (name, fallback) => {
    const file = env[`${name}_FILE`];
    if (file !== undefined && env[name] !== undefined)
      fail("configuration", `configure one of ${name} and ${name}_FILE`);
    const read = file !== undefined ? readFileSync(file, "utf8").trim() : env[name]?.trim();
    if (read) return read;
    if (fallback !== undefined) return fallback;
    return fail("configuration", `${name} is required`);
  };
  const given = value("OPENSTEER_SYNTHETIC_ACCOUNT_URL");
  const origin = new URL(given);
  if (origin.protocol !== "https:" || origin.origin !== given.replace(/\/$/u, ""))
    fail("configuration", "OPENSTEER_SYNTHETIC_ACCOUNT_URL must be a bare https origin");
  const minutes = (name, fallback) => {
    const parsed = Number(value(name, String(fallback)));
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 240)
      fail("configuration", `${name} must be a whole number of minutes from 1 to 240`);
    return parsed;
  };
  const heartbeat = value("OPENSTEER_SYNTHETIC_HEARTBEAT_URL", "");
  return {
    origin: origin.origin,
    email: value("OPENSTEER_SYNTHETIC_EMAIL"),
    password: value("OPENSTEER_SYNTHETIC_PASSWORD"),
    readyMs: minutes("OPENSTEER_SYNTHETIC_READY_MINUTES", 30) * 60_000,
    goneMs: minutes("OPENSTEER_SYNTHETIC_GONE_MINUTES", 20) * 60_000,
    ...(heartbeat ? { heartbeat: new URL(heartbeat) } : {}),
  };
}

/** The account service, as a signed-in person's browser speaks to it. */
function accountClient(config, fetch) {
  const cookies = new Map();
  const remember = (response) => {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  };
  return async (method, path, body) => {
    const response = await fetch(new URL(path, config.origin), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/json",
        origin: config.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookies.size
          ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    remember(response);
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  };
}

async function launchChromium() {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ headless: true });
}

/**
 * Pays a Stripe test-mode Checkout Session on Stripe's own hosted page, as a person would: the
 * documented surface, in a headless Chromium, with Stripe's test card. Refuses anything but a
 * test session, so it can never charge a real card.
 */
async function payOnCheckoutPage(config, launchBrowser, checkoutUrl) {
  const url = new URL(checkoutUrl);
  if (url.hostname !== "checkout.stripe.com" || !/\/cs_test_[A-Za-z0-9]+/u.test(url.pathname))
    fail("payment", "the checkout address is not a Stripe test-mode Checkout page");
  const browser = await launchBrowser().catch(() => fail("payment", "Chromium did not start"));
  try {
    const page = await browser.newPage();
    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const optional = async (selector, text) => {
      const field = page.locator(selector);
      if (await field.isVisible({ timeout: 2_000 }).catch(() => false)) await field.fill(text);
    };
    await optional("#email", config.email);
    const year = String((new Date().getUTCFullYear() + 5) % 100).padStart(2, "0");
    await page.locator("#cardNumber").fill("4242424242424242", { timeout: 30_000 });
    await page.locator("#cardExpiry").fill(`12${year}`);
    await page.locator("#cardCvc").fill("123");
    await optional("#billingName", "Opensteer synthetic purchase");
    await optional("#billingPostalCode", "94103");
    await page.locator('button[type="submit"]').click();
    // Paid: the page sends the browser back to the account's own return address.
    await page.waitForURL((next) => !next.hostname.endsWith("stripe.com"), { timeout: 120_000 });
  } catch (error) {
    if (error instanceof StepFailed) throw error;
    fail("payment", `Stripe's Checkout page could not be completed (${error?.name ?? "error"})`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function until(deadlineMs, everyMs, check, sleep, now) {
  const end = now() + deadlineMs;
  for (;;) {
    const answer = await check();
    if (answer !== undefined) return answer;
    if (now() >= end) return undefined;
    await sleep(everyMs);
  }
}

/** Whether a name still resolves: an error that says it does not exist is gone. */
async function nameResolves(hostname, dns) {
  const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.length) return true;
    if (result.status === "rejected" && !["ENOTFOUND", "ENODATA"].includes(result.reason?.code))
      return true;
  }
  return false;
}

/**
 * One run. `fetch`, `dns`, `launchBrowser`, `sleep`, `now` and `log` are the outside world, given so
 * that a test can stand in for them. Returns the exit code.
 */
export async function runSyntheticPurchase(config, world = {}) {
  const fetch = world.fetch ?? globalThis.fetch;
  const dns = world.dns ?? { resolve4, resolve6 };
  const launchBrowser = world.launchBrowser ?? launchChromium;
  const sleep = world.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const clock = world.now ?? Date.now;
  const log = world.log ?? ((line) => console.log(JSON.stringify(line)));
  const started = Date.now();
  const seconds = {};
  const mark = (step) => {
    seconds[step] = Math.round((Date.now() - started) / 1000);
  };
  const account = accountClient(config, fetch);
  /** What this run bought: everything in its own account that was not there when it began. */
  let known;
  let computerId;
  const hostnames = new Map();

  const list = async (step) => {
    const { status, json } = await account("GET", "/v1/account/cloud-computers");
    if (status !== 200 || !Array.isArray(json?.computers))
      fail(step, `listing Cloud Computers answered HTTP ${status}`);
    for (const computer of json.computers)
      if (computer.address) hostnames.set(computer.id, new URL(computer.address).hostname);
    return json.computers;
  };
  const show = async (id, step) => {
    const { status, json } = await account("GET", `/v1/account/cloud-computers/${id}`);
    if (status !== 200) fail(step, `reading ${id} answered HTTP ${status}`);
    if (json?.address) hostnames.set(id, new URL(json.address).hostname);
    return json;
  };

  /** Deletes one of its own Cloud Computers and waits until the machine and its name are gone. */
  const deleteAndWait = async (id, steps) => {
    const view = await show(id, steps.delete);
    if (view.status !== "deleted" && !view.deletion) {
      const removal = await account("DELETE", `/v1/account/cloud-computers/${id}`, {
        confirmation: `DELETE:${id}`,
      });
      if (removal.status !== 200) fail(steps.delete, `deleting answered HTTP ${removal.status}`);
    }
    const gone = await until(
      config.goneMs,
      15_000,
      async () => {
        const now = await show(id, steps.gone);
        if (now.status !== "deleted" || !now.deletion?.computerDestroyedAt) return undefined;
        const hostname = hostnames.get(id);
        if (hostname && (await nameResolves(hostname, dns))) return undefined;
        return true;
      },
      sleep,
      clock,
    );
    if (!gone)
      fail(
        steps.gone,
        `the machine or its DNS name was not gone within ${config.goneMs / 60_000} minutes`,
      );
  };

  let result;
  try {
    const signIn = await account("POST", "/api/auth/sign-in/app-review", {
      email: config.email,
      password: config.password,
    });
    if (signIn.status !== 200)
      fail("sign-in", `the synthetic sign-in answered HTTP ${signIn.status}`);
    // Its own account: anything live in it was left by an earlier run, and goes first.
    const before = await list("sign-in");
    mark("sign-in");
    for (const leftover of before.filter((computer) => computer.status !== "deleted")) {
      await deleteAndWait(leftover.id, { delete: "leftover", gone: "leftover" });
      log({ event: "synthetic.run.leftover-deleted", computerId: leftover.id });
    }
    known = new Set(before.map((computer) => computer.id));
    mark("leftover");

    const checkout = await account("POST", "/v1/account/cloud-computers/checkout", {
      requestId: randomUUID(),
    });
    if (checkout.status !== 200 || typeof checkout.json?.url !== "string")
      fail(
        "checkout",
        `checkout answered HTTP ${checkout.status} ${checkout.json?.error?.code ?? ""}`.trim(),
      );
    mark("checkout");
    await payOnCheckoutPage(config, launchBrowser, checkout.json.url);
    // The account's own computer appears once Stripe's webhook (or its 60-second pass) arrives.
    computerId = await until(
      5 * 60_000,
      5_000,
      async () => {
        const created = (await list("payment")).filter((computer) => !known.has(computer.id));
        if (created.length > 1) fail("payment", "more than one new Cloud Computer appeared");
        return created[0]?.id;
      },
      sleep,
      clock,
    );
    if (!computerId) fail("payment", "no Cloud Computer appeared within 5 minutes of paying");
    mark("payment");

    const ready = await until(
      config.readyMs,
      15_000,
      async () => {
        const view = await show(computerId, "ready");
        if (view.status === "needs_attention")
          fail("ready", `the Cloud Computer needs attention (${view.reasonCode ?? "no code"})`);
        return view.status === "ready" ? view : undefined;
      },
      sleep,
      clock,
    );
    if (!ready) fail("ready", `not ready within ${config.readyMs / 60_000} minutes`);
    mark("ready");

    // The Home answers at its address as the Home the account claimed for this person.
    const discovery = await fetch(new URL("/.well-known/opensteer", ready.address), {
      signal: AbortSignal.timeout(30_000),
    }).catch(() => fail("home", "its address did not answer"));
    const document = discovery.ok ? await discovery.json().catch(() => undefined) : undefined;
    const authority = document?.authority?.document;
    if (
      !authority ||
      authority.canonicalOrigin !== new URL(ready.address).origin ||
      (ready.deploymentId && authority.deploymentId !== ready.deploymentId)
    )
      fail("home", `its discovery document is not the claimed Home (HTTP ${discovery.status})`);
    const setup = await fetch(new URL("/v1/rpc/auth.config?input=%7B%7D", ready.address), {
      signal: AbortSignal.timeout(30_000),
      headers: { "x-opensteer-api-version": String(document.apiVersion) },
    }).catch(() => fail("home", "its sign-in configuration did not answer"));
    const configured = setup.ok ? await setup.json().catch(() => undefined) : undefined;
    if (configured?.data?.setupState !== "complete")
      fail("home", "the Home does not say it was claimed");
    mark("home");
    result = { event: "synthetic.run.passed" };
  } catch (error) {
    const step = error instanceof StepFailed ? error.step : "configuration";
    const detail = error instanceof StepFailed ? error.detail : "the run stopped unexpectedly";
    result = { event: "synthetic.run.failed", step, detail };
  } finally {
    // Whatever happened, nothing this run bought is left running: every Cloud Computer in its
    // own account that was not there when it began, the one it knew and any that appeared late.
    if (known) {
      const made = new Set(computerId ? [computerId] : []);
      try {
        for (const computer of await list("delete"))
          if (!known.has(computer.id) && computer.status !== "deleted") made.add(computer.id);
      } catch {
        // The list is read again by the next run, which deletes what is left.
      }
      for (const id of made)
        try {
          await deleteAndWait(id, { delete: "delete", gone: "gone" });
          mark("gone");
        } catch (error) {
          const step = error instanceof StepFailed ? error.step : "delete";
          if (result?.event !== "synthetic.run.failed")
            result = { event: "synthetic.run.failed", step, detail: error?.detail ?? "" };
          log({ event: "synthetic.run.cleanup-failed", step, computerId: id });
        }
    }
  }
  log({ ...result, ...(computerId ? { computerId } : {}), seconds });
  if (result.event === "synthetic.run.passed") {
    if (config.heartbeat)
      await fetch(config.heartbeat, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    return 0;
  }
  return steps[result.step] ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config;
  try {
    config = readConfiguration();
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "synthetic.run.failed",
        step: "configuration",
        detail: error instanceof StepFailed ? error.detail : "unreadable configuration",
      }),
    );
    process.exit(steps.configuration);
  }
  process.exit(await runSyntheticPurchase(config));
}
