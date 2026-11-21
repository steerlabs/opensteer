import { hostApi } from "@opensteer/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { mockBrowserPoolReport } from "../mock/browser-sleep-fixtures.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { BrowserRestartUnavailable, restartPooledBrowser } from "./browser-sleep.js";
import { HttpHostClient } from "./host-session-client.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

/** A personal Home whose answer to `browser.pool.restart` the test chooses. */
function home(pooled: string | undefined, answer: () => unknown) {
  const mock = new MockHostClient({ latencyMs: 0 });
  if (pooled) mock.setBrowserPools([mockBrowserPoolReport("awake", pooled, "srf_page")]);
  const host = new MockPersonalHost(mock);
  const restarts: unknown[] = [];
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch")) {
        const raw = url.searchParams.get("input") ?? init?.body;
        const command = hostApi["commands.dispatch"].payload.parse(JSON.parse(String(raw)));
        if (command.type === "browser.pool.restart") {
          restarts.push(command);
          return Response.json(answer());
        }
      }
      return host.fetch(input, init);
    },
    webSocketFactory: host.connect,
  });
  disposals.push(
    () => client.dispose(),
    () => host.dispose(),
  );
  return { client, restarts };
}

const refusal = (code: string) => ({
  ok: false,
  error: { code, message: "This browser does not restart.", retryable: false },
});

it("sends the owner's restart to a Home that reports this pooled browser", async () => {
  const { client, restarts } = home("rnr_cloud", () => ({
    ok: true,
    data: { type: "browser.pool.restart" },
  }));
  await client.load();
  await vi.waitFor(() =>
    expect(client.getSnapshot().browserPools?.[0]?.runnerId).toBe("rnr_cloud"),
  );
  // The screens' own entry point reaches the Home now.
  await expect(restartPooledBrowser(client, "rnr_cloud")).resolves.toBeUndefined();
  expect(restarts).toEqual([
    { type: "browser.pool.restart", runnerId: "rnr_cloud", idempotencyKey: expect.any(String) },
  ]);
});

it("refuses without sending anything where no pooled browser is reported", async () => {
  // An ordinary Home reports no pool: the client refuses before any request.
  const ordinary = home(undefined, () => {
    throw new Error("nothing should be sent");
  });
  await ordinary.client.load();
  await expect(restartPooledBrowser(ordinary.client, "rnr_cloud")).rejects.toBeInstanceOf(
    BrowserRestartUnavailable,
  );
  // A Home with a pool refuses a computer it does not report, too, without asking.
  const other = home("rnr_cloud", () => {
    throw new Error("nothing should be sent");
  });
  await other.client.load();
  await vi.waitFor(() => expect(other.client.getSnapshot().browserPools).toHaveLength(1));
  await expect(restartPooledBrowser(other.client, "rnr_other")).rejects.toBeInstanceOf(
    BrowserRestartUnavailable,
  );
  expect([...ordinary.restarts, ...other.restarts]).toEqual([]);
});

it.each(["not_found", "forbidden"])(
  "reads the Home's %s refusal as the same fixed refusal",
  async (code) => {
    const { client, restarts } = home("rnr_cloud", () => refusal(code));
    await client.load();
    await vi.waitFor(() => expect(client.getSnapshot().browserPools).toHaveLength(1));
    await expect(restartPooledBrowser(client, "rnr_cloud")).rejects.toThrow(
      "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
    );
    expect(restarts).toHaveLength(1);
  },
);

it("keeps any other failure as itself, so the screen says it did not happen", async () => {
  const { client } = home("rnr_cloud", () => refusal("internal"));
  await client.load();
  await vi.waitFor(() => expect(client.getSnapshot().browserPools).toHaveLength(1));
  const failure = await restartPooledBrowser(client, "rnr_cloud").catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(BrowserRestartUnavailable);
  expect(failure).toBeInstanceOf(Error);
});
