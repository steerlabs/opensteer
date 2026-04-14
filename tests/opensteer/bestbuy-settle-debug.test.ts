/**
 * Regression test for the cross-document post-load tracker timeout issue.
 *
 * Heavy sites like Best Buy keep making background fetch requests (analytics,
 * ads, lazy data) that prevent the post-load tracker from settling within the
 * action-boundary timeout.  After the fix, cross-document navigations cap the
 * post-load quiet check at CROSS_DOCUMENT_POST_LOAD_SETTLE_TIMEOUT_MS so the
 * action does not time out waiting for network quiet on chatty pages.
 */
import { afterAll, describe, expect, test } from "vitest";
import { OpensteerRuntime } from "../../packages/opensteer/src/sdk/runtime.js";

describe("Best Buy search submit — cross-document settle regression", () => {
  let runtime: OpensteerRuntime | undefined;

  afterAll(async () => {
    if (runtime) {
      try {
        await runtime.close();
      } catch {}
    }
  }, 30_000);

  test("clicking search submit completes without timing out on post-load tracker", async () => {
    runtime = new OpensteerRuntime({
      workspace: "bestbuy-settle-regression",
    });

    await runtime.open({
      url: "https://www.bestbuy.com",
      launch: { headless: true },
    });

    await new Promise((r) => setTimeout(r, 3000));

    await runtime.input(
      {
        text: "laptop",
        target: { kind: "selector", selector: 'textarea[aria-label="Search"]' },
      },
      { timeoutMs: 15_000 },
    );

    const startMs = Date.now();
    await runtime.click(
      {
        target: { kind: "selector", selector: 'button[aria-label="Search-Button"]' },
      },
      { timeoutMs: 45_000 },
    );
    const elapsed = Date.now() - startMs;

    // Verify navigation happened
    const snap = await runtime.snapshot({ mode: "action" });
    expect(snap.url).toContain("searchpage");

    // Verify the click didn't take the full timeout — it should complete in
    // well under 30s now that the post-load tracker is capped.
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);
});
