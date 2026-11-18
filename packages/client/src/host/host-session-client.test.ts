import { createClientAction } from "../actions/client-action.js";
import { unsupportedVersionCloseCode } from "@opensteer/protocol";
import type { ClientLifecycle, ClientNetworkState } from "./lifecycle.js";
import { MockPersonalHost, MockPersonalSocket } from "../mock/mock-personal-host.js";
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { HttpHostClient } from "./host-session-client.js";

describe("attachment reads", () => {
  const boundedRead = (client: HttpHostClient, id: string, signal?: AbortSignal) =>
    withTimeout(client.readAttachment(id, signal), 1_000, {
      timeoutError: () => new Error("Attachment read did not settle"),
    });
  const content = (size = 4) => ({
    ok: true as const,
    data: {
      bytes: new Uint8Array(size),
      metadata: {
        contentType: "image/png",
        etag: "immutable",
        modifiedAt: null,
        sizeBytes: size,
        truncated: false as const,
      },
    },
  });
  function attachmentRpc(client: HttpHostClient) {
    const rpc = vi.fn<(typeof client.rpc)["attachment.content"]>();
    Object.defineProperty(client.rpc, "attachment.content", { value: rpc });
    return rpc;
  }
  function pendingRead() {
    const client = new HttpHostClient({ baseUrl: "http://scoped-host" });
    let complete!: (value: ReturnType<typeof content>) => void;
    const pending = new Promise<ReturnType<typeof content>>((resolve) => {
      complete = resolve;
    });
    const rpc = attachmentRpc(client).mockReturnValue(pending);
    return { client, rpc, complete };
  }

  it("shares concurrent reads, isolates cancellation, and caches completed bytes", async () => {
    const { client, rpc, complete } = pendingRead();
    try {
      const abort = new AbortController();
      const first = boundedRead(client, "image", abort.signal);
      const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
      const second = boundedRead(client, "image");
      abort.abort();
      await rejected;
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]![1]?.signal?.aborted).toBe(false);
      complete(content());
      expect((await second).size).toBe(4);
      expect((await boundedRead(client, "image")).size).toBe(4);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });

  it("keeps the request through synchronous cleanup and remount, then cancels when unused", async () => {
    const { client, rpc } = pendingRead();
    try {
      const a = new AbortController();
      const first = boundedRead(client, "image", a.signal);
      const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
      a.abort();
      const b = new AbortController();
      const second = boundedRead(client, "image", b.signal);
      const secondRejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
      await firstRejected;
      expect(rpc).toHaveBeenCalledTimes(1);
      const signal = rpc.mock.calls[0]![1]!.signal!;
      expect(signal.aborted).toBe(false);
      b.abort();
      expect(signal.aborted).toBe(false);
      await secondRejected;
      expect(signal.aborted).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("aborts active reads and refuses cached bytes after disposal", async () => {
    const { client, rpc, complete } = pendingRead();
    try {
      const completed = boundedRead(client, "cached");
      complete(content());
      await completed;
      rpc.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = boundedRead(client, "pending");
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      client.dispose();
      await rejected;
      expect(rpc.mock.calls[1]![1]!.signal!.aborted).toBe(true);
      await expect(boundedRead(client, "cached")).rejects.toMatchObject({ name: "AbortError" });
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it("evicts least recently used bytes and excludes oversized items", async () => {
    const client = new HttpHostClient({ baseUrl: "http://scoped-host" });
    const rpc = attachmentRpc(client).mockResolvedValue(content(12 * 1024 * 1024));
    try {
      await boundedRead(client, "a");
      await boundedRead(client, "b");
      await boundedRead(client, "a");
      await boundedRead(client, "c");
      await boundedRead(client, "a");
      expect(rpc).toHaveBeenCalledTimes(3);
      await boundedRead(client, "b");
      expect(rpc).toHaveBeenCalledTimes(4);
      rpc.mockResolvedValue(content(33 * 1024 * 1024));
      await boundedRead(client, "large");
      await boundedRead(client, "large");
      expect(rpc).toHaveBeenCalledTimes(6);
    } finally {
      client.dispose();
    }
  });

  it("does not cache failures or issue a request for an already aborted caller", async () => {
    const client = new HttpHostClient({ baseUrl: "http://scoped-host" });
    const rpc = attachmentRpc(client)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(content());
    try {
      await expect(boundedRead(client, "image")).rejects.toThrow("offline");
      await boundedRead(client, "image");
      expect(rpc).toHaveBeenCalledTimes(2);
      await expect(boundedRead(client, "other", AbortSignal.abort())).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });
});

describe("personal connection admission", () => {
  it("admits a scoped connection before a ready-gated action and names the Host", async () => {
    const host = new MockPersonalHost();
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      fetch: host.fetch,
      webSocketFactory: host.connect,
    });
    const releaseIdentity = client.watchPersonalResource("identity", () => {});
    const execute = vi.fn(async () => "confirmed");
    const action = createClientAction(client, {
      key: "open:test",
      label: "open this",
      done: "opened",
      execute,
    });
    try {
      await client.load();
      const connected = client.getSnapshot();
      expect(client.connection.getSnapshot()).toMatchObject({
        phase: "ready",
        readyRevision: 1,
        scope: {
          loginId: connected.sessionId,
          deploymentId: connected.deploymentId,
          viewerId: connected.user?.id,
        },
      });
      await vi.waitFor(() =>
        expect(client.connection.getSnapshot().name).toBe(
          host.client.getSnapshot().identityConfig?.deployment.name,
        ),
      );
      await expect(action.run(undefined)).resolves.toMatchObject({
        kind: "confirmed",
        value: "confirmed",
      });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      releaseIdentity();
      action.dispose();
      client.dispose();
      host.dispose();
    }
  });

  it("reports an exact Personal version refusal immediately", async () => {
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      webSocketFactory: () => {
        const socket = new MockPersonalSocket(() => undefined);
        socket.addEventListener("open", () =>
          socket.emit("close", { code: unsupportedVersionCloseCode, reason: "Update Opensteer" }),
        );
        return socket;
      },
    });
    try {
      await client.load();
      expect(client.connection.getSnapshot()).toMatchObject({
        phase: "blocked",
        showInterruption: true,
        issue: { code: "update-app" },
      });
    } finally {
      client.dispose();
    }
  });

  it("defers personal attach while offline and aborts the old path before opening a socket", async () => {
    let change: (network: ClientNetworkState, path: "same" | "changed") => void = () => {};
    const lifecycle: ClientLifecycle = {
      getSnapshot: () => ({ network: "offline", visibility: "foreground" }),
      onNetworkChange: (listener) => {
        change = listener;
        return () => {};
      },
      onBackground: () => () => {},
      onForeground: () => () => {},
    };
    const host = new MockPersonalHost();
    const first = Promise.withResolvers<void>();
    const prepareSocket = vi
      .fn<() => Promise<void>>(async () => undefined)
      .mockReturnValueOnce(first.promise);
    const open = vi.fn(host.connect);
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      fetch: host.fetch,
      lifecycle,
      prepareSocket,
      webSocketFactory: open,
    });
    try {
      await client.load();
      expect(prepareSocket).not.toHaveBeenCalled();
      change("online", "changed");
      expect(prepareSocket).toHaveBeenCalledOnce();
      change("online", "changed");
      await client.load();
      expect(prepareSocket).toHaveBeenCalledTimes(2);
      expect(client.connection.getSnapshot().phase).toBe("ready");
      first.resolve();
      await first.promise;
      expect(open).toHaveBeenCalledOnce();
    } finally {
      first.resolve();
      client.dispose();
      host.dispose();
    }
  });
});
