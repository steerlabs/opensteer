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

describe("Host RPC slow-link deadlines", () => {
  const answer = JSON.stringify({
    ok: false,
    error: { code: "forbidden", message: "No access.", retryable: false },
  });
  function setup(fetch: typeof globalThis.fetch) {
    const onAuthenticationRequired = vi.fn();
    return {
      client: createHttpHostApiClient({
        baseUrl: new URL("https://host.example"),
        fetch,
        onAuthenticationRequired,
      }),
      onAuthenticationRequired,
    };
  }

  it("aborts stalled headers as a retryable operation error without replaying a POST", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
        signal = init?.signal;
        return new Promise(() => {});
      });
      const { client, onAuthenticationRequired } = setup(fetch);
      const pending = client["commands.dispatch"]({
        type: "thread.rename",
        threadId: createId("thread"),
        title: "Renamed",
        idempotencyKey: "retained-rename-key",
      });
      await vi.advanceTimersByTimeAsync(44_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signal?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { reason: "transport-timed-out", retryable: true },
      });
      expect(onAuthenticationRequired).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "reads steady bytes beyond 30 seconds; stalled midway: %s",
    async (stall) => {
      vi.useFakeTimers();
      try {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let signal: AbortSignal | null | undefined;
        const cancel = vi.fn();
        const { client, onAuthenticationRequired } = setup(async (_url, init) => {
          signal = init?.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
              },
              cancel,
            }),
          );
        });
        const pending = client["auth.config"]({});
        await vi.advanceTimersByTimeAsync(0);
        for (const part of [answer.slice(0, 20), answer.slice(20, 40), answer.slice(40)]) {
          await vi.advanceTimersByTimeAsync(19_000);
          stream.enqueue(new TextEncoder().encode(part));
          await vi.advanceTimersByTimeAsync(0);
          if (stall) break;
        }
        if (stall) {
          await vi.advanceTimersByTimeAsync(20_000);
          await expect(pending).resolves.toMatchObject({
            ok: false,
            error: { reason: "transport-timed-out", retryable: true },
          });
          expect(signal?.aborted).toBe(true);
          expect(cancel).toHaveBeenCalled();
        } else {
          stream.close();
          await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
        }
        expect(onAuthenticationRequired).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("gives caller cancellation precedence even when the deadline fires first", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const { client } = setup(() => new Promise(() => {}));
      const pending = client["auth.config"]({}, { signal: caller.signal });
      const cancelled = pending.catch((error: unknown) => error);
      // Both happen before the rejected fetch is observed by the request path.
      vi.advanceTimersByTime(45_000);
      caller.abort(new DOMException("Left the page", "AbortError"));
      await expect(pending).rejects.toBe(caller.signal.reason);
      expect(await cancelled).toBe(caller.signal.reason);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("honors per-operation header and body stall overrides for binary previews", async () => {
  vi.useFakeTimers();
  try {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://host.example"),
      onAuthenticationRequired: vi.fn(),
      fetch: () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  new ReadableStream({
                    start(controller) {
                      stream = controller;
                    },
                  }),
                ),
              ),
            25_000,
          );
        }),
    });
    const pending = client["workspace.files.preview"](
      { workspaceId: createId("workspace"), fileKey: "file" },
      { responseHeadersTimeoutMs: 30_000, bodyStallTimeoutMs: 40_000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    stream.enqueue(new Uint8Array([1, 2, 3]));
    stream.close();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { bytes: new Uint8Array([1, 2, 3]) },
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the preview byte limit on the decoded stream", async () => {
  const client = createHttpHostApiClient({
    baseUrl: new URL("https://host.example"),
    onAuthenticationRequired: vi.fn(),
    fetch: async () =>
      new Response(new Uint8Array(512 * 1_024 + 1), {
        headers: { "content-length": "1", "content-encoding": "gzip" },
      }),
  });
  await expect(
    client["workspace.files.preview"]({ workspaceId: createId("workspace"), fileKey: "file" }),
  ).resolves.toMatchObject({
    ok: false,
    error: { reason: "transport-response-too-large", retryable: false },
  });
});

it("bounds an unavailable JS body stream with a size-scaled fallback", async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | null | undefined;
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://host.example"),
      onAuthenticationRequired: vi.fn(),
      fetch: async (_url, init) => {
        signal = init?.signal;
        return {
          body: null,
          headers: new Headers(),
          arrayBuffer: () => new Promise(() => {}),
        } as Response;
      },
    });
    const pending = client["workspace.files.preview"]({
      workspaceId: createId("workspace"),
      fileKey: "file",
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(512_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { reason: "transport-timed-out", retryable: true },
    });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("cancels a pending body read immediately with the caller's reason", async () => {
  vi.useFakeTimers();
  try {
    const caller = new AbortController();
    const cancel = vi.fn();
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://host.example"),
      onAuthenticationRequired: vi.fn(),
      fetch: async () => new Response(new ReadableStream({ cancel })),
    });
    const pending = client["auth.config"]({}, { signal: caller.signal });
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(new DOMException("Left the page", "AbortError"));
    expect(await outcome).toBe(caller.signal.reason);
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
