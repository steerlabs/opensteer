import { describe, expect, it } from "vitest";
import {
  readConfiguration,
  runSyntheticPurchase,
  steps,
} from "../scripts/synthetic-cloud-computer.mjs";

const origin = "https://account.example.test";
const config = {
  origin,
  email: "synthetic@example.test",
  password: "synthetic-password-long-enough",
  readyMs: 60_000,
  goneMs: 60_000,
  heartbeat: new URL("https://hc.example.test/ping/synthetic"),
};
const earlier = "cc_00000000-0000-4000-8000-000000000001";
const ours = "cc_00000000-0000-4000-8000-000000000002";
const checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_a1B2#fragment";

interface Options {
  /** A Cloud Computer an earlier run left live in the account. */
  readonly leftover?: boolean;
  /** How many reads before the Cloud Computer is ready; Infinity for never. */
  readonly readyAfter?: number;
  /** The paid computer appears only after this many list reads (late webhook). */
  readonly appearsAfter?: number;
  readonly checkoutUrl?: string;
}

/** A stand-in for the account, Stripe's hosted page, the Home and DNS, with a clock of its own. */
function world(options: Options = {}) {
  const calls: string[] = [];
  const page: string[] = [];
  const lines: Record<string, unknown>[] = [];
  let time = 0;
  let paid = false;
  let lists = 0;
  let reads = 0;
  const deleted = new Set<string>();
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const view = (id: string) => {
    if (deleted.has(id))
      return { id, status: "deleted", deletion: { computerDestroyedAt: "2026-11-24T10:00:00Z" } };
    if (id === earlier) return { id, status: "ready", address: "https://h0.homes.example.test" };
    reads += 1;
    return reads > (options.readyAfter ?? 1)
      ? { id, status: "ready", address: "https://h1.homes.example.test", deploymentId: "dep_1" }
      : { id, status: "preparing" };
  };
  const fetch = async (target: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(target));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.origin === origin ? url.pathname : url.href}`);
    if (url.origin === origin) {
      if (url.pathname === "/api/auth/sign-in/app-review") {
        expect(JSON.parse(String(init.body))).toEqual({
          email: config.email,
          password: config.password,
        });
        return json({ redirect: true }, 200, { "set-cookie": "session=s1; Path=/; HttpOnly" });
      }
      if (new Headers(init.headers).get("cookie") !== "session=s1")
        return json({ error: { code: "unauthorized" } }, 401);
      if (url.pathname === "/v1/account/cloud-computers") {
        lists += 1;
        const visible = paid && lists > (options.appearsAfter ?? 0);
        return json({
          computers: [
            ...(options.leftover
              ? [{ id: earlier, status: deleted.has(earlier) ? "deleted" : "ready" }]
              : []),
            ...(visible ? [view(ours)] : []),
          ],
        });
      }
      if (url.pathname === "/v1/account/cloud-computers/checkout")
        return json({ url: options.checkoutUrl ?? checkoutUrl });
      const id = url.pathname.split("/").at(-1)!;
      if (method === "DELETE") {
        deleted.add(id);
        return json({ id, status: "suspended" });
      }
      return json(view(id));
    }
    if (url.origin === "https://h1.homes.example.test") {
      if (url.pathname === "/.well-known/opensteer")
        return json({
          apiVersion: 7,
          authority: {
            document: { canonicalOrigin: "https://h1.homes.example.test", deploymentId: "dep_1" },
          },
        });
      if (url.pathname === "/v1/rpc/auth.config") return json({ data: { setupState: "complete" } });
    }
    if (url.href === config.heartbeat.href) return new Response("OK");
    throw new Error(`unexpected ${url.href}`);
  };
  // Stripe's hosted page as a headless browser sees it: fields, the Pay button, the way back.
  const launchBrowser = async () => ({
    close: async () => page.push("closed"),
    newPage: async () => ({
      goto: async (address: string) => page.push(`goto ${address}`),
      locator: (selector: string) => ({
        isVisible: async () => selector === "#email" || selector === "#billingName",
        fill: async (text: string) => page.push(`fill ${selector} ${text}`),
        click: async () => {
          page.push(`click ${selector}`);
          paid = true;
        },
      }),
      waitForURL: async () => page.push("returned"),
    }),
  });
  const gone = () => Object.assign(new Error("gone"), { code: "ENOTFOUND" });
  const dns = {
    resolve4: async (name: string) => {
      if ([...deleted].some((id) => name.startsWith(id === ours ? "h1." : "h0."))) throw gone();
      return ["203.0.113.9"];
    },
    resolve6: async () => {
      throw Object.assign(new Error("none"), { code: "ENODATA" });
    },
  };
  return {
    calls,
    page,
    lines,
    deleted,
    world: {
      fetch,
      dns,
      launchBrowser,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      log: (line: Record<string, unknown>) => lines.push(line),
    },
  };
}

describe("the synthetic purchase", () => {
  it("pays on Stripe's hosted page with the test card, waits, opens the Home, and deletes it", async () => {
    const run = world();
    expect(await runSyntheticPurchase(config, run.world)).toBe(0);
    expect(run.page).toEqual([
      `goto ${checkoutUrl}`,
      `fill #email ${config.email}`,
      "fill #cardNumber 4242424242424242",
      expect.stringMatching(/^fill #cardExpiry 12\d\d$/u),
      "fill #cardCvc 123",
      "fill #billingName Opensteer synthetic purchase",
      'click button[type="submit"]',
      "returned",
      "closed",
    ]);
    // No call to any Stripe API: only the page a person sees.
    expect(run.calls.some((call) => call.includes("api.stripe.com"))).toBe(false);
    expect(run.calls).toContain(`DELETE /v1/account/cloud-computers/${ours}`);
    expect(run.lines.at(-1)).toMatchObject({ event: "synthetic.run.passed", computerId: ours });
    expect(run.calls.at(-1)).toBe(`GET ${config.heartbeat.href}`);
  });

  it("deletes what an earlier run left in its own account before it buys (S7)", async () => {
    const run = world({ leftover: true });
    expect(await runSyntheticPurchase(config, run.world)).toBe(0);
    const order = run.calls.filter(
      (call) => call.startsWith("DELETE") || call.includes("checkout"),
    );
    expect(order).toEqual([
      `DELETE /v1/account/cloud-computers/${earlier}`,
      "POST /v1/account/cloud-computers/checkout",
      `DELETE /v1/account/cloud-computers/${ours}`,
    ]);
    expect(run.lines[0]).toEqual({ event: "synthetic.run.leftover-deleted", computerId: earlier });
  });

  it("deletes a computer that appeared only after it gave up waiting, and fails at payment (S7)", async () => {
    // One list at sign-in and 61 over the five minutes it waits (every 5 s): it shows from the
    // next read on, the one the cleanup makes.
    const run = world({ appearsAfter: 62 });
    expect(await runSyntheticPurchase(config, run.world)).toBe(steps.payment);
    expect(run.deleted).toEqual(new Set([ours]));
    expect(run.lines.at(-1)).toMatchObject({ event: "synthetic.run.failed", step: "payment" });
    expect(run.calls).not.toContain(`GET ${config.heartbeat.href}`);
  });

  it("fails with the step's code when not ready in its bound, and still deletes what it made", async () => {
    const run = world({ readyAfter: Number.POSITIVE_INFINITY });
    expect(await runSyntheticPurchase({ ...config, readyMs: 0 }, run.world)).toBe(steps.ready);
    expect(run.lines.at(-1)).toMatchObject({
      event: "synthetic.run.failed",
      step: "ready",
      computerId: ours,
    });
    expect(run.deleted).toEqual(new Set([ours]));
  });

  it("never pays anything but a Stripe test-mode session", async () => {
    const run = world({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_a1B2" });
    expect(await runSyntheticPurchase(config, run.world)).toBe(steps.payment);
    expect(run.page).toEqual([]);
    expect(run.deleted).toEqual(new Set());
  });

  it("needs its own account and a bare https account origin", () => {
    const env = {
      OPENSTEER_SYNTHETIC_ACCOUNT_URL: origin,
      OPENSTEER_SYNTHETIC_EMAIL: config.email,
      OPENSTEER_SYNTHETIC_PASSWORD: config.password,
    };
    expect(readConfiguration(env)).toMatchObject({ origin, readyMs: 30 * 60_000 });
    for (const change of [
      { OPENSTEER_SYNTHETIC_EMAIL: "" },
      { OPENSTEER_SYNTHETIC_ACCOUNT_URL: "http://account.example.test" },
      { OPENSTEER_SYNTHETIC_ACCOUNT_URL: `${origin}/v1` },
    ])
      expect(() => readConfiguration({ ...env, ...change })).toThrow();
  });
});
