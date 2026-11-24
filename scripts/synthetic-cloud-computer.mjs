#!/usr/bin/env node
// The synthetic purchase: one person's whole Cloud Computer path, end to end, against an
// Opensteer account service in Stripe TEST mode, so a broken purchase is found before a person
// finds it (deploy/monitoring/policies/page-synthetic-failed-twice.yaml).
//
//   1. sign in with the account service's review sign-in
//   2. check out, and pay with Stripe's test card through Stripe's API (no browser)
//   3. wait, within a bound, for the Cloud Computer to be ready
//   4. open its address and check the Home answers as the one the account claimed
//   5. delete it (which cancels its subscription) and wait until the machine and its DNS name
//      are gone
//
// It is safe to run every few hours: it starts only when the review account has no live Cloud
// Computer, and it only ever touches the one it created, by its id. A run that fails after it
// created one still deletes that one. It writes one JSON line per run, `synthetic.run.passed`
// or `synthetic.run.failed` with the failed step, and exits with that step's code.
//
// Configuration (each also as <NAME>_FILE):
//   OPENSTEER_SYNTHETIC_ACCOUNT_URL              https origin of the account service
//   OPENSTEER_SYNTHETIC_REVIEW_EMAIL             its review sign-in (OPENSTEER_APP_REVIEW_EMAIL)
//   OPENSTEER_SYNTHETIC_REVIEW_PASSWORD          and password
//   OPENSTEER_SYNTHETIC_STRIPE_PUBLISHABLE_KEY   the account's Stripe test publishable key (pk_test_)
//   OPENSTEER_SYNTHETIC_READY_MINUTES            bound for step 3 (default 30)
//   OPENSTEER_SYNTHETIC_GONE_MINUTES             bound for step 5 (default 20)
//   OPENSTEER_SYNTHETIC_HEARTBEAT_URL            optional: a GET after a passing run
//
// No dependencies: it runs with Node 22 or later and nothing else.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve4, resolve6 } from "node:dns/promises";
import { pathToFileURL } from "node:url";

/** Each step's exit code; the JSON line names the step. */
export const steps = {
  configuration: 2,
  "sign-in": 10,
  "account-not-empty": 11,
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
  const origin = new URL(value("OPENSTEER_SYNTHETIC_ACCOUNT_URL"));
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value("OPENSTEER_SYNTHETIC_ACCOUNT_URL").replace(/\/$/u, "")
  )
    fail("configuration", "OPENSTEER_SYNTHETIC_ACCOUNT_URL must be a bare https origin");
  const stripeKey = value("OPENSTEER_SYNTHETIC_STRIPE_PUBLISHABLE_KEY");
  // Only ever Stripe's test mode: a live key would charge a real card.
  if (!/^pk_test_[A-Za-z0-9]+$/u.test(stripeKey))
    fail("configuration", "the Stripe key must be a test publishable key (pk_test_)");
  const minutes = (name, fallback) => {
    const parsed = Number(value(name, String(fallback)));
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 240)
      fail("configuration", `${name} must be a whole number of minutes from 1 to 240`);
    return parsed;
  };
  const heartbeat = value("OPENSTEER_SYNTHETIC_HEARTBEAT_URL", "");
  return {
    origin: origin.origin,
    email: value("OPENSTEER_SYNTHETIC_REVIEW_EMAIL"),
    password: value("OPENSTEER_SYNTHETIC_REVIEW_PASSWORD"),
    stripeKey,
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

/**
 * Pays an open Stripe Checkout Session with the test card, through the same calls Stripe's
 * hosted checkout page makes with the publishable key. These endpoints are Stripe's own and not
 * documented; if Stripe changes them, this step fails with code `payment`.
 */
async function payWithTestCard(config, fetch, checkoutUrl) {
  const session = /\/(cs_test_[A-Za-z0-9]+)/u.exec(new URL(checkoutUrl).pathname)?.[1];
  if (!session) fail("payment", "the checkout address is not a Stripe test Checkout Session");
  const stripe = async (path, form) => {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${config.stripeKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
      fail(
        "payment",
        `Stripe ${path.split("/")[0]} ${path.split("/").at(-1)}: HTTP ${response.status} ${json?.error?.code ?? ""}`.trim(),
      );
    return json;
  };
  const page = await stripe(`payment_pages/${session}/init`, {
    browser_locale: "en-US",
    eid: "NA",
    redirect_type: "url",
  });
  const amount = page?.total_summary?.due ?? page?.line_item_group?.total ?? page?.invoice?.total;
  const method = await stripe("payment_methods", {
    type: "card",
    "card[number]": "4242424242424242",
    "card[cvc]": "123",
    "card[exp_month]": "12",
    "card[exp_year]": String(new Date().getUTCFullYear() + 5),
    "billing_details[name]": "Opensteer synthetic purchase",
    "billing_details[email]": config.email,
    "billing_details[address][country]": "US",
    "billing_details[address][postal_code]": "94103",
  });
  const confirmed = await stripe(`payment_pages/${session}/confirm`, {
    eid: "NA",
    payment_method: method.id,
    expected_payment_method_type: "card",
    ...(amount === undefined ? {} : { expected_amount: String(amount) }),
    ...(page?.init_checksum ? { init_checksum: page.init_checksum } : {}),
    ...(page?.customer_email ? {} : { email: config.email }),
  });
  if (confirmed?.status && confirmed.status !== "complete" && confirmed.status !== "open")
    fail("payment", `Stripe said ${confirmed.status}`);
}

async function until(deadlineMs, everyMs, check, sleep) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const answer = await check();
    if (answer !== undefined) return answer;
    if (Date.now() >= end) return undefined;
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
 * One run. `fetch`, `dns`, `sleep` and `log` are the outside world, given so that a test can
 * stand in for them. Returns the exit code.
 */
export async function runSyntheticPurchase(config, world = {}) {
  const fetch = world.fetch ?? globalThis.fetch;
  const dns = world.dns ?? { resolve4, resolve6 };
  const sleep = world.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const log = world.log ?? ((line) => console.log(JSON.stringify(line)));
  const started = Date.now();
  const seconds = {};
  const mark = (step) => {
    seconds[step] = Math.round((Date.now() - started) / 1000);
  };
  const account = accountClient(config, fetch);
  let computerId;
  let hostname;

  const list = async () => {
    const { status, json } = await account("GET", "/v1/account/cloud-computers");
    if (status !== 200 || !Array.isArray(json?.computers))
      fail("sign-in", `listing Cloud Computers answered HTTP ${status}`);
    return json.computers;
  };
  const show = async (step) => {
    const { status, json } = await account("GET", `/v1/account/cloud-computers/${computerId}`);
    if (status !== 200) fail(step, `reading ${computerId} answered HTTP ${status}`);
    return json;
  };

  const deleteAndWait = async () => {
    const removal = await account("DELETE", `/v1/account/cloud-computers/${computerId}`, {
      confirmation: `DELETE:${computerId}`,
    });
    if (removal.status !== 200) fail("delete", `deleting answered HTTP ${removal.status}`);
    mark("delete");
    const gone = await until(
      config.goneMs,
      15_000,
      async () => {
        const view = await show("gone");
        if (view.status !== "deleted" || !view.deletion?.computerDestroyedAt) return undefined;
        if (hostname && (await nameResolves(hostname, dns))) return undefined;
        return true;
      },
      sleep,
    );
    if (!gone)
      fail(
        "gone",
        `the machine or its DNS name was not gone within ${config.goneMs / 60_000} minutes`,
      );
    mark("gone");
  };

  try {
    const signIn = await account("POST", "/api/auth/sign-in/app-review", {
      email: config.email,
      password: config.password,
    });
    if (signIn.status !== 200) fail("sign-in", `the review sign-in answered HTTP ${signIn.status}`);
    const before = await list();
    if (before.some((computer) => computer.status !== "deleted"))
      fail(
        "account-not-empty",
        "the review account already has a live Cloud Computer; nothing was touched",
      );
    const known = new Set(before.map((computer) => computer.id));
    mark("sign-in");

    const checkout = await account("POST", "/v1/account/cloud-computers/checkout", {
      requestId: randomUUID(),
    });
    if (checkout.status !== 200 || typeof checkout.json?.url !== "string")
      fail(
        "checkout",
        `checkout answered HTTP ${checkout.status} ${checkout.json?.error?.code ?? ""}`.trim(),
      );
    mark("checkout");
    await payWithTestCard(config, fetch, checkout.json.url);
    // The account's own computer appears once Stripe's webhook (or its 60-second pass) arrives.
    computerId = await until(
      5 * 60_000,
      5_000,
      async () => {
        const created = (await list()).filter((computer) => !known.has(computer.id));
        if (created.length > 1) fail("payment", "more than one new Cloud Computer appeared");
        return created[0]?.id;
      },
      sleep,
    );
    if (!computerId) fail("payment", "no Cloud Computer appeared within 5 minutes of paying");
    mark("payment");

    const ready = await until(
      config.readyMs,
      15_000,
      async () => {
        const view = await show("ready");
        if (view.status === "needs_attention")
          fail("ready", `the Cloud Computer needs attention (${view.reasonCode ?? "no code"})`);
        return view.status === "ready" ? view : undefined;
      },
      sleep,
    );
    if (!ready) fail("ready", `not ready within ${config.readyMs / 60_000} minutes`);
    hostname = new URL(ready.address).hostname;
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

    await deleteAndWait();
    log({ event: "synthetic.run.passed", computerId, seconds });
    if (config.heartbeat)
      await fetch(config.heartbeat, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    return 0;
  } catch (error) {
    const step = error instanceof StepFailed ? error.step : "configuration";
    const detail = error instanceof StepFailed ? error.detail : "the run stopped unexpectedly";
    log({
      event: "synthetic.run.failed",
      step,
      detail,
      ...(computerId ? { computerId } : {}),
      seconds,
    });
    // Never leave a Cloud Computer this run made, so the next run starts clean.
    if (computerId && step !== "delete" && step !== "gone")
      await deleteAndWait().catch((cleanup) =>
        log({
          event: "synthetic.run.cleanup-failed",
          step: cleanup instanceof StepFailed ? cleanup.step : "delete",
          computerId,
        }),
      );
    return steps[step] ?? 1;
  }
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
