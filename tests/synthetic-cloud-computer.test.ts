import { describe, expect, it } from "vitest";
import {
  readConfiguration,
  runSyntheticPurchase,
  steps,
} from "../scripts/synthetic-cloud-computer.mjs";

const origin = "https://account.example.test";
const config = {
  origin,
  email: "review@example.test",
  password: "review-password",
  stripeKey: "pk_test_abc",
  readyMs: 60_000,
  goneMs: 60_000,
  heartbeat: new URL("https://hc.example.test/ping/synthetic"),
};
const theirs = { id: "cc_00000000-0000-4000-8000-000000000001", status: "deleted" };
const ours = "cc_00000000-0000-4000-8000-000000000002";

/** A stand-in for the account service, Stripe, the Home and DNS, recording every call. */
function world(options: { readonly live?: boolean; readonly readyAfter?: number } = {}) {
  const calls: string[] = [];
  let paid = false;
  let reads = 0;
  let deleted = false;
  let dnsGone = false;
  const lines: Record<string, unknown>[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const fetch = async (target: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(target));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.origin === origin ? url.pathname : url.href}`);
    if (url.origin === origin) {
      const cookie = new Headers(init.headers).get("cookie");
      if (url.pathname === "/api/auth/sign-in/app-review")
        return json({ redirect: true }, 200, { "set-cookie": "session=s1; Path=/; HttpOnly" });
      if (cookie !== "session=s1") return json({ error: { code: "unauthorized" } }, 401);
      if (url.pathname === "/v1/account/cloud-computers")
        return json({
          computers: [
            options.live ? { ...theirs, status: "ready" } : theirs,
            ...(paid ? [{ id: ours, status: "preparing" }] : []),
          ],
        });
      if (url.pathname === "/v1/account/cloud-computers/checkout")
        return json({ url: "https://checkout.stripe.com/c/pay/cs_test_a1B2#fragment" });
      if (url.pathname === `/v1/account/cloud-computers/${ours}` && method === "DELETE") {
        deleted = true;
        return json({ id: ours, status: "suspended" });
      }
      if (url.pathname === `/v1/account/cloud-computers/${ours}`) {
        reads += 1;
        if (deleted) {
          dnsGone = true;
          return json({
            id: ours,
            status: "deleted",
            deletion: { computerDestroyedAt: "2026-11-24T10:00:00Z" },
          });
        }
        return reads > (options.readyAfter ?? 1)
          ? json({
              id: ours,
              status: "ready",
              address: "https://h1.homes.example.test",
              deploymentId: "dep_1",
            })
          : json({ id: ours, status: "preparing" });
      }
      return json({ error: { code: "not_found" } }, 404);
    }
    if (url.hostname === "api.stripe.com") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer pk_test_abc");
      if (url.pathname === "/v1/payment_pages/cs_test_a1B2/init")
        return json({ init_checksum: "c1", total_summary: { due: 2900 } });
      if (url.pathname === "/v1/payment_methods") return json({ id: "pm_1" });
      if (url.pathname === "/v1/payment_pages/cs_test_a1B2/confirm") {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("payment_method")).toBe("pm_1");
        expect(form.get("expected_amount")).toBe("2900");
        paid = true;
        return json({ status: "complete" });
      }
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
  const missing = () => Object.assign(new Error("gone"), { code: "ENOTFOUND" });
  const dns = {
    resolve4: async () => {
      if (dnsGone) throw missing();
      return ["203.0.113.9"];
    },
    resolve6: async () => {
      throw Object.assign(new Error("none"), { code: "ENODATA" });
    },
  };
  return {
    calls,
    lines,
    world: {
      fetch,
      dns,
      sleep: async () => undefined,
      log: (line: Record<string, unknown>) => lines.push(line),
    },
  };
}

describe("the synthetic purchase", () => {
  it("buys, waits, opens the claimed Home, deletes it and waits until it and its name are gone", async () => {
    const run = world();
    expect(await runSyntheticPurchase(config, run.world)).toBe(0);
    expect(run.lines).toEqual([
      expect.objectContaining({ event: "synthetic.run.passed", computerId: ours }),
    ]);
    // It touched only the computer it created, by its id, and never the one already there.
    expect(run.calls.filter((call) => call.includes("cc_"))).not.toContainEqual(
      expect.stringContaining(theirs.id),
    );
    expect(run.calls).toContain(`DELETE /v1/account/cloud-computers/${ours}`);
    expect(run.calls.at(-1)).toBe(`GET ${config.heartbeat.href}`);
  });

  it("touches nothing when the review account already has a live Cloud Computer", async () => {
    const run = world({ live: true });
    expect(await runSyntheticPurchase(config, run.world)).toBe(steps["account-not-empty"]);
    expect(run.calls.some((call) => call.includes("checkout") || call.startsWith("DELETE"))).toBe(
      false,
    );
    expect(run.lines).toEqual([
      expect.objectContaining({ event: "synthetic.run.failed", step: "account-not-empty" }),
    ]);
  });

  it("fails with the step's code when not ready in its bound, and still deletes what it made", async () => {
    const run = world({ readyAfter: Number.POSITIVE_INFINITY });
    expect(await runSyntheticPurchase({ ...config, readyMs: 0 }, run.world)).toBe(steps.ready);
    expect(run.lines).toEqual([
      expect.objectContaining({ event: "synthetic.run.failed", step: "ready", computerId: ours }),
    ]);
    expect(run.calls).toContain(`DELETE /v1/account/cloud-computers/${ours}`);
    expect(run.calls).not.toContain(`GET ${config.heartbeat.href}`);
  });

  it("refuses anything but Stripe's test mode and a bare https account origin", () => {
    const env = {
      OPENSTEER_SYNTHETIC_ACCOUNT_URL: origin,
      OPENSTEER_SYNTHETIC_REVIEW_EMAIL: config.email,
      OPENSTEER_SYNTHETIC_REVIEW_PASSWORD: config.password,
      OPENSTEER_SYNTHETIC_STRIPE_PUBLISHABLE_KEY: "pk_test_abc",
    };
    expect(readConfiguration(env)).toMatchObject({ origin, readyMs: 30 * 60_000 });
    for (const change of [
      { OPENSTEER_SYNTHETIC_STRIPE_PUBLISHABLE_KEY: "pk_live_abc" },
      { OPENSTEER_SYNTHETIC_STRIPE_PUBLISHABLE_KEY: "sk_test_abc" },
      { OPENSTEER_SYNTHETIC_ACCOUNT_URL: "http://account.example.test" },
      { OPENSTEER_SYNTHETIC_ACCOUNT_URL: `${origin}/v1` },
    ])
      expect(() => readConfiguration({ ...env, ...change })).toThrow();
  });
});
