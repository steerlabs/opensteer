import { appIdFromHostname, appOriginHeader, appOriginKey } from "@opensteer/shared/appFrame";
import { expect, it, vi } from "vitest";
import router from "./connect-app-router.js";

const deployment = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0ff";
const appId = "app_11111111-2222-4333-8444-555555555555";
const hostname = `${appOriginKey(appId)}-${deployment.replaceAll("-", "")}.opensteerapp.com`;

function forward() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("from Host"));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("sends an app origin to its Deployment's Connect hostname and states the real origin", async () => {
  const fetch = forward();
  const response = await router.fetch(
    new Request(`https://${hostname}/api/items?done=1`, {
      method: "POST",
      body: "item",
      headers: { cookie: "__Host-session=one", [appOriginHeader]: "https://forged.example" },
    }),
  );
  expect(await response.text()).toBe("from Host");
  const [request, init] = fetch.mock.calls[0]!;
  const forwarded = request as Request;
  expect(forwarded.url).toBe(
    `https://connect-${deployment}.opensteerapp.com/api/items?done=1`,
  );
  expect(forwarded.method).toBe("POST");
  expect(await forwarded.text()).toBe("item");
  const headers = new Headers(init?.headers);
  expect(headers.get(appOriginHeader)).toBe(`https://${hostname}`);
  expect(headers.get("cookie")).toBe("__Host-session=one");
  expect(init?.redirect).toBe("manual");
  expect(appIdFromHostname(new URL(headers.get(appOriginHeader)!).hostname)).toBe(appId);
});

it.each([
  `https://connect-${deployment}.opensteerapp.com/`,
  "https://opensteerapp.com/",
  "https://unknown.opensteerapp.com/",
  `https://${appOriginKey(appId)}.opensteerapp.com/`,
])("refuses a name that is not an app origin: %s", async (url) => {
  const fetch = forward();
  expect((await router.fetch(new Request(url))).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
