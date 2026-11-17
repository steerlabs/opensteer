import { expect, it } from "vitest";
import type { HostTransport } from "@opensteer/client/connections";
import { forwardMedia } from "./media-protocol.js";
const id = "dep_11111111-1111-4111-8111-111111111111";
const url = `app://opensteer/media/${id}/payload.signature/image%20one.png`;
it("binds to the URL Deployment, allows only media response headers and retains the exchange through consumption", async () => {
  let settled = false;
  const response = await forwardMedia(new Request(url), async (deploymentId) => {
    expect(deploymentId).toBe(id);
    return {
      exchange: async (request, read) => {
        expect(request).toMatchObject({
          expectedDeploymentId: id,
          path: "/media/payload.signature/image%20one.png",
          credentials: "omit",
        });
        const value = await read(
          new Response("image", {
            headers: {
              "content-type": "image/png",
              "content-length": "5",
              "cache-control": "private",
              etag: '"r"',
              "x-content-type-options": "nosniff",
              "content-security-policy": "sandbox",
              "set-cookie": "secret",
              location: "https://elsewhere",
            },
          }),
          { signal: request.signal!, onProgress: () => undefined },
        );
        settled = true;
        return value;
      },
    } satisfies Pick<HostTransport, "exchange">;
  });
  expect(settled).toBe(false);
  expect(response.headers.get("content-security-policy")).toBe("sandbox");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("location")).toBeNull();
  expect(await response.text()).toBe("image");
});
it("bounds bytes and propagates abort while waiting for an upstream body", async () => {
  const abort = new AbortController();
  let canceled = false;
  const response = await forwardMedia(new Request(url, { signal: abort.signal }), async () => ({
    exchange: async (request, read) =>
      read(
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
        ),
        { signal: request.signal!, onProgress: () => undefined },
      ),
  }));
  const body = response.text();
  abort.abort(new Error("stopped"));
  await expect(body).rejects.toThrow("stopped");
  expect(canceled).toBe(true);
  const oversized = await forwardMedia(new Request(url), async () => ({
    exchange: async (request, read) =>
      read(new Response("x", { headers: { "content-length": String(65 * 1024 * 1024) } }), {
        signal: request.signal!,
        onProgress: () => undefined,
      }),
  }));
  await expect(oversized.arrayBuffer()).rejects.toThrow();
});

it("forwards v2 resource claims unchanged without attaching a session credential", async () => {
  const payload = btoa(
    JSON.stringify({
      v: 2,
      sessionId: "session",
      userId: "owner",
      threadId: null,
      resource: { kind: "home", key: "a2V5", revision: "revision" },
      variant: "preview",
      exp: 123456,
    }),
  )
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  const token = `${payload}.signature`;
  const response = await forwardMedia(
    new Request(`app://opensteer/media/${id}/${token}/preview.webp`),
    async () => ({
      exchange: async (request, read) => {
        expect(request.path).toBe(`/media/${token}/preview.webp`);
        expect(request.credentials).toBe("omit");
        expect(request.headers).toEqual({});
        expect(request.expectedDeploymentId).toBe(id);
        return read(
          new Response("preview", {
            headers: {
              "content-type": "image/webp",
              "content-security-policy": "default-src 'none'; sandbox",
            },
          }),
          { signal: request.signal!, onProgress: () => undefined },
        );
      },
    }),
  );
  expect(await response.text()).toBe("preview");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
});
