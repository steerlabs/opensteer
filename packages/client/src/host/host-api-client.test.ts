import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { createHttpHostApiClient } from "./host-api-client.js";

describe("HTTP Host rpc response parsing", () => {
  it("strips additive fields from the response envelope and its data", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              futureDataField: "ignored",
              url: "com.opensteer.mobile:/oauth/host-callback?code=ready",
            },
            futureEnvelopeField: "ignored",
            ok: true,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://opensteer.example"),
      fetch,
      onAuthenticationRequired: vi.fn(),
    });

    await expect(
      client["auth.native.complete"]({ accept: true, oauthQuery: "client_id=opensteer-mobile" }),
    ).resolves.toEqual({
      data: { url: "com.opensteer.mobile:/oauth/host-callback?code=ready" },
      ok: true,
    });
  });

  it("strips additive fields from error envelopes", async () => {
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://opensteer.example"),
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "forbidden",
              futureErrorField: "ignored",
              message: "Not available here.",
              retryable: false,
            },
            futureEnvelopeField: "ignored",
            ok: false,
          }),
          { status: 403 },
        ),
      onAuthenticationRequired: vi.fn(),
    });

    await expect(client["auth.config"]({})).resolves.toEqual({
      error: { code: "forbidden", message: "Not available here.", retryable: false },
      ok: false,
    });
  });
});

describe("bounded Host rpc requests", () => {
  it("sends a maximum valid file key and percent-expanded search in JSON bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: { code: "forbidden", message: "No access.", retryable: false }, ok: false },
        { status: 403 },
      ),
    );
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://opensteer.example"),
      fetch,
      onAuthenticationRequired: vi.fn(),
    });
    const workspaceId = createId("workspace");
    await client["workspace.files.list"]({ parentKey: "a".repeat(5_462), workspaceId });
    await client["thread.messages.list"]({ threadId: createId("thread"), query: "界".repeat(256) });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(new URL(url.toString()).search).toBe("");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    }
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).parentKey).toHaveLength(5_462);
  });

  it("refuses invalid payload before fetch with an operation-local error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://opensteer.example"),
      fetch,
      onAuthenticationRequired: vi.fn(),
    });
    const result = await client["workspace.files.list"]({
      parentKey: "a".repeat(5_463),
      workspaceId: createId("workspace"),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "invalid-payload", retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns bridge rejection as a per-call transport error without a status callback", async () => {
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://opensteer.example"),
      fetch: async () => {
        throw new Error("IPC schema refused this request");
      },
      onAuthenticationRequired: vi.fn(),
    });
    const result = await client["auth.config"]({});
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "transport-unreachable", retryable: true },
    });
  });

  it("preserves a Host operation refusal without treating it as network loss", async () => {
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://opensteer.example"),
      fetch: async () =>
        Response.json(
          { error: { code: "internal", message: "Failed operation.", retryable: true }, ok: false },
          { status: 503 },
        ),
      onAuthenticationRequired: vi.fn(),
    });
    expect(await client["auth.config"]({})).toEqual({
      error: { code: "internal", message: "Failed operation.", retryable: true },
      ok: false,
    });
  });
});
