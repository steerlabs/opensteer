import { createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { forwardHostRoute } from "./host-route.js";

it("forwards only the bundled app's own requests, to a /v1 path under the Deployment they name", async () => {
  const forward = vi.fn(async () => new Response("forwarded"));
  const id = createId("deployment");
  const route = (url: string, initiatorOrigin?: string) =>
    forwardHostRoute(Object.assign(new Request(url), initiatorOrigin ? { initiatorOrigin } : {}), {
      forward,
    });

  const accepted = await route(`app://opensteer/host/${id}/v1/rpc/x?input=1`, "app://opensteer");
  expect(await accepted.text()).toBe("forwarded");
  expect(forward).toHaveBeenCalledExactlyOnceWith(id, "/v1/rpc/x?input=1", expect.any(Request));

  for (const initiator of [undefined, "null", "http://app.localhost:4310", "opensteer-app://view"])
    expect((await route(`app://opensteer/host/${id}/v1/rpc/x`, initiator)).status).toBe(403);
  for (const path of ["/internal/secrets", "/v1/%252e%252e/internal", "/.well-known/opensteer"])
    expect((await route(`app://opensteer/host/${id}${path}`, "app://opensteer")).status).toBe(404);
  expect(
    (await route("app://opensteer/host/not-a-deployment/v1/x", "app://opensteer")).status,
  ).toBe(404);
  expect(forward).toHaveBeenCalledOnce();
});
