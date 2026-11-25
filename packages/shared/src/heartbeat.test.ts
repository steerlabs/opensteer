import { describe, expect, it, vi } from "vitest";
import { heartbeatUrl, sendHeartbeat } from "./heartbeat.js";

describe("heartbeats", () => {
  it("sends one plain GET and reports only a failed one", async () => {
    const answered = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      answered.resolve();
      return new Response("OK");
    });
    const onError = vi.fn();
    sendHeartbeat(new URL("https://hc.example.test/ping/abc"), { fetch, onError });
    await answered.promise;
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://hc.example.test/ping/abc"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    await vi.waitFor(() => expect(onError).not.toHaveBeenCalled());

    const failed = vi.fn();
    sendHeartbeat(new URL("https://hc.example.test/ping/abc"), {
      fetch: async () => new Response("no", { status: 503 }),
      onError: failed,
    });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(503));
    const unreachable = vi.fn();
    sendHeartbeat(new URL("https://hc.example.test/ping/abc"), {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      onError: unreachable,
    });
    await vi.waitFor(() => expect(unreachable).toHaveBeenCalledWith("unreachable"));
  });

  it("sends nothing without an address and accepts only an https address without a password", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    sendHeartbeat(undefined, { fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(heartbeatUrl(undefined)).toBeUndefined();
    expect(heartbeatUrl(" ")).toBeUndefined();
    expect(heartbeatUrl("https://hc.example.test/ping/abc")?.href).toBe(
      "https://hc.example.test/ping/abc",
    );
    expect(() => heartbeatUrl("http://hc.example.test/ping")).toThrow();
    expect(() => heartbeatUrl("https://user:secret@hc.example.test/ping")).toThrow();
  });
});
