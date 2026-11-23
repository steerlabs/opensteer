import { createId } from "@opensteer/core";
import { createClientAction } from "../actions/client-action.js";
import { expectedMutationSessionHeader, unsupportedVersionCloseCode } from "@opensteer/protocol";
import type { ClientLifecycle, ClientNetworkState } from "./lifecycle.js";
import { MockPersonalHost, MockPersonalSocket } from "../mock/mock-personal-host.js";
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { HttpHostClient, type WebSocketClient } from "./host-session-client.js";

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

describe("mutation session fencing", () => {
  it("sends the Host AuthSessionId rather than a mobile viewLoginId in x-opensteer-expected-session", async () => {
    const host = new MockPersonalHost();
    const viewLoginId = crypto.randomUUID();
    const sentDispatches: { readonly type: string; readonly session: string | null }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch") && typeof init?.body === "string") {
        const command = JSON.parse(init.body) as { type: string };
        sentDispatches.push({
          type: command.type,
          session: new Headers(init.headers).get(expectedMutationSessionHeader),
        });
      }
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      fetch,
      webSocketFactory: host.connect,
      clientScope: () => {
        const snapshot = client.getSnapshot();
        return snapshot.deploymentId && snapshot.user
          ? {
              authorityKey: "mobile-authority",
              deploymentId: snapshot.deploymentId,
              viewerId: snapshot.user.id,
              loginId: viewLoginId,
            }
          : null;
      },
    });
    try {
      await client.load();
      const scope = client.connection.getSnapshot().scope;
      const hostSessionId = client.getSnapshot().sessionId;
      expect(scope?.loginId).toBe(viewLoginId);
      expect(hostSessionId).toMatch(/^ses_/);
      expect(hostSessionId).not.toBe(viewLoginId);

      const seed = host.client.getSnapshot();
      const harness = seed.harnesses[0]!;
      const modelSelection = seed.threads[0]!.modelSelection;
      const thread = await client.createThread(
        {
          accessMode: seed.executionPreferences.accessMode,
          environmentId: harness.environmentId,
          harnessInstanceId: harness.id,
          modelSelection,
          title: "Mobile task",
        },
        scope!,
      );
      expect(thread.title).toBe("Mobile task");

      await client.dispatch(
        {
          type: "thread.sendMessage",
          threadId: thread.id,
          content: [{ type: "text", text: "Hello from iPhone" }],
          idempotencyKey: "msg_mobile_1",
        },
        { expectedLogin: scope! },
      );
      expect(
        sentDispatches.filter(
          ({ type }) => type === "thread.create" || type === "thread.sendMessage",
        ),
      ).toEqual([
        { type: "thread.create", session: hostSessionId },
        { type: "thread.sendMessage", session: hostSessionId },
      ]);
      const dispatchedBeforeStale = sentDispatches.length;

      // A stale scope is rejected locally without touching the Host or expiring the active login.
      await expect(
        client.createThread(
          {
            accessMode: seed.executionPreferences.accessMode,
            environmentId: harness.environmentId,
            harnessInstanceId: harness.id,
            modelSelection,
            title: "Stale task",
          },
          { ...scope!, loginId: crypto.randomUUID() },
        ),
      ).rejects.toMatchObject({ failure: { reason: "session-changed" } });
      expect(sentDispatches).toHaveLength(dispatchedBeforeStale);
      expect(client.getSnapshot().session).toBe("authenticated");
    } finally {
      client.dispose();
      host.dispose();
    }
  });

  it("expires the session when the Host reports session-changed for the active AuthSessionId", async () => {
    const host = new MockPersonalHost();
    const viewLoginId = crypto.randomUUID();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch")) {
        return Response.json(
          {
            ok: false,
            error: {
              code: "forbidden",
              reason: "session-changed",
              message: "This request belongs to another sign-in.",
              retryable: false,
            },
          },
          { status: 403 },
        );
      }
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      fetch,
      webSocketFactory: host.connect,
      clientScope: () => {
        const snapshot = client.getSnapshot();
        return snapshot.deploymentId && snapshot.user
          ? {
              authorityKey: "mobile-authority",
              deploymentId: snapshot.deploymentId,
              viewerId: snapshot.user.id,
              loginId: viewLoginId,
            }
          : null;
      },
    });
    const reauthenticate = vi.spyOn(client, "reauthenticate").mockResolvedValue(undefined);
    try {
      await client.load();
      const scope = client.connection.getSnapshot().scope!;
      const seed = host.client.getSnapshot();
      const harness = seed.harnesses[0]!;
      const modelSelection = seed.threads[0]!.modelSelection;
      await expect(
        client.createThread(
          {
            accessMode: seed.executionPreferences.accessMode,
            environmentId: harness.environmentId,
            harnessInstanceId: harness.id,
            modelSelection,
            title: "Rotated session task",
          },
          scope,
        ),
      ).rejects.toMatchObject({ reason: "session-changed" });
      expect(client.getSnapshot().session).toBe("authentication-required");
      expect(client.connection.getSnapshot().scope).toBeNull();
      expect(reauthenticate).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
      host.dispose();
    }
  });

  it("refuses expectedLogin mutations locally when no Host AuthSessionId is known", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      fetch,
    });
    const scope = {
      authorityKey: "mobile-authority",
      deploymentId: "dep_0192f4a1-4444-4000-8000-000000000004",
      viewerId: "usr_0192f4a1-4444-4000-8000-000000000001",
      loginId: crypto.randomUUID(),
    };
    vi.spyOn(client.connection, "getSnapshot").mockReturnValue({
      ...client.connection.getSnapshot(),
      phase: "ready",
      scope,
    });
    try {
      await expect(
        client.dispatch(
          {
            type: "thread.sendMessage",
            threadId: "thr_0192f4a1-4444-4000-8000-000000000001",
            content: [{ type: "text", text: "Unfenced send" }],
            idempotencyKey: "msg_unfenced",
          },
          { expectedLogin: scope },
        ),
      ).rejects.toMatchObject({ failure: { reason: "session-changed" } });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("blocks an old login's task creation between a replacement shell snapshot and synchronization", async () => {
    const host = new MockPersonalHost();
    const sessionB = createId("authSession");
    let holdSync = false;
    let rewriteSession: typeof sessionB | null = null;
    const heldSync: (() => void)[] = [];
    const dispatched: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch")) dispatched.push(url.pathname);
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      capabilities: [],
      fetch,
      reconnectBaseDelayMs: 0,
      webSocketFactory: () => {
        const socket = host.connect();
        const send = socket.send.bind(socket);
        const deliver = socket.deliver.bind(socket);
        socket.send = (data) => {
          if (rewriteSession && typeof data === "string") {
            const frame = JSON.parse(data) as Record<string, unknown>;
            if (frame.type === "client.attach") {
              const { cursor: _ignored, ...rest } = frame;
              return send(JSON.stringify(rest));
            }
          }
          send(data);
        };
        socket.deliver = (frame) => {
          if (
            rewriteSession &&
            frame.type === "host.snapshot" &&
            "subscriptionId" in frame &&
            frame.subscriptionId === "shell"
          ) {
            const snapshot = frame.snapshot as Record<string, unknown>;
            return deliver({
              ...frame,
              snapshot: {
                ...snapshot,
                session: {
                  ...(snapshot.session as Record<string, unknown>),
                  sessionId: rewriteSession,
                },
              },
            } as typeof frame);
          }
          if (
            holdSync &&
            frame.type === "host.synchronized" &&
            "subscriptionId" in frame &&
            frame.subscriptionId === "shell"
          ) {
            heldSync.push(() => deliver(frame));
            return;
          }
          deliver(frame);
        };
        return socket as unknown as WebSocketClient;
      },
    });
    try {
      await client.load();
      const scopeA = client.connection.getSnapshot().scope!;
      const sessionA = client.getSnapshot().sessionId!;
      expect(scopeA.loginId).toBe(sessionA);

      // Reconnect delivers session B's shell snapshot while holding synchronization,
      // leaving connection.scope on scopeA while snapshot.sessionId has moved to sessionB.
      rewriteSession = sessionB;
      holdSync = true;
      for (const socket of host.sockets) socket.close();
      await vi.waitFor(() => expect(client.getSnapshot().sessionId).toBe(sessionB));
      expect(client.connection.getSnapshot().scope).toEqual(scopeA);

      const seed = host.client.getSnapshot();
      const harness = seed.harnesses[0]!;
      await expect(
        client.createThread(
          {
            accessMode: seed.executionPreferences.accessMode,
            environmentId: harness.environmentId,
            harnessInstanceId: harness.id,
            modelSelection: seed.threads[0]!.modelSelection,
            title: "Cross-session task",
          },
          scopeA,
        ),
      ).rejects.toMatchObject({ failure: { reason: "session-changed" } });
      expect(dispatched).toEqual([]);

      // Releasing synchronization admits session B cleanly.
      for (const release of heldSync.splice(0)) release();
      await vi.waitFor(() => expect(client.connection.getSnapshot().scope?.loginId).toBe(sessionB));
    } finally {
      client.dispose();
      host.dispose();
    }
  });

  it("ignores a delayed 401 from an earlier session once a replacement session is active", async () => {
    const host = new MockPersonalHost();
    const sessionB = createId("authSession");
    let rewriteSession: typeof sessionB | null = null;
    const held401 = Promise.withResolvers<Response>();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/machines.list")) return held401.promise;
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      capabilities: [],
      fetch,
      reconnectBaseDelayMs: 0,
      webSocketFactory: () => {
        const socket = host.connect();
        const send = socket.send.bind(socket);
        const deliver = socket.deliver.bind(socket);
        socket.send = (data) => {
          if (rewriteSession && typeof data === "string") {
            const frame = JSON.parse(data) as Record<string, unknown>;
            if (frame.type === "client.attach") {
              const { cursor: _ignored, ...rest } = frame;
              return send(JSON.stringify(rest));
            }
          }
          send(data);
        };
        socket.deliver = (frame) => {
          if (
            rewriteSession &&
            frame.type === "host.snapshot" &&
            "subscriptionId" in frame &&
            frame.subscriptionId === "shell"
          ) {
            const snapshot = frame.snapshot as Record<string, unknown>;
            return deliver({
              ...frame,
              snapshot: {
                ...snapshot,
                session: {
                  ...(snapshot.session as Record<string, unknown>),
                  sessionId: rewriteSession,
                },
              },
            } as typeof frame);
          }
          deliver(frame);
        };
        return socket as unknown as WebSocketClient;
      },
    });
    try {
      await client.load();
      const staleRead = client.rpc["machines.list"]({});

      rewriteSession = sessionB;
      host.repairShell();
      await vi.waitFor(() => expect(client.getSnapshot().sessionId).toBe(sessionB));

      held401.resolve(
        Response.json(
          { ok: false, error: { code: "unauthorized", message: "Signed out", retryable: false } },
          { status: 401 },
        ),
      );
      await staleRead;
      expect(client.getSnapshot().session).toBe("authenticated");
      expect(client.getSnapshot().sessionId).toBe(sessionB);
    } finally {
      held401.resolve(Response.json({ ok: true, data: { machines: [] } }));
      client.dispose();
      host.dispose();
    }
  });

  it("does not send createThread's follow-up preference write after the session changes", async () => {
    const host = new MockPersonalHost();
    const sessionB = createId("authSession");
    let rewriteSession: typeof sessionB | null = null;
    const holdCreate = Promise.withResolvers<void>();
    const commandTypes: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch") && typeof init?.body === "string") {
        const command = JSON.parse(init.body) as { type: string };
        commandTypes.push(command.type);
        if (command.type === "thread.create") await holdCreate.promise;
      }
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      capabilities: [],
      fetch,
      reconnectBaseDelayMs: 0,
      webSocketFactory: () => {
        const socket = host.connect();
        const send = socket.send.bind(socket);
        const deliver = socket.deliver.bind(socket);
        socket.send = (data) => {
          if (rewriteSession && typeof data === "string") {
            const frame = JSON.parse(data) as Record<string, unknown>;
            if (frame.type === "client.attach") {
              const { cursor: _ignored, ...rest } = frame;
              return send(JSON.stringify(rest));
            }
          }
          send(data);
        };
        socket.deliver = (frame) => {
          if (
            rewriteSession &&
            frame.type === "host.snapshot" &&
            "subscriptionId" in frame &&
            frame.subscriptionId === "shell"
          ) {
            const snapshot = frame.snapshot as Record<string, unknown>;
            return deliver({
              ...frame,
              snapshot: {
                ...snapshot,
                session: {
                  ...(snapshot.session as Record<string, unknown>),
                  sessionId: rewriteSession,
                },
              },
            } as typeof frame);
          }
          deliver(frame);
        };
        return socket as unknown as WebSocketClient;
      },
    });
    try {
      await client.load();
      const scopeA = client.connection.getSnapshot().scope!;
      const seed = host.client.getSnapshot();
      const harness = seed.harnesses[0]!;
      const creating = client.createThread(
        {
          accessMode: seed.executionPreferences.accessMode,
          environmentId: harness.environmentId,
          harnessInstanceId: harness.id,
          modelSelection: seed.threads[0]!.modelSelection,
          title: "In-flight create",
        },
        scopeA,
      );
      await vi.waitFor(() => expect(commandTypes).toContain("thread.create"));

      rewriteSession = sessionB;
      host.repairShell();
      await vi.waitFor(() => expect(client.getSnapshot().sessionId).toBe(sessionB));

      holdCreate.resolve();
      await creating;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(commandTypes).toEqual(["thread.create"]);
    } finally {
      holdCreate.resolve();
      client.dispose();
      host.dispose();
    }
  });

  it("enforces expectedLogin and sends AuthSessionId for thread.icon.set", async () => {
    const host = new MockPersonalHost();
    const sent: { readonly type: string; readonly session: string | null }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch") && typeof init?.body === "string") {
        const command = JSON.parse(init.body) as { type: string };
        sent.push({
          type: command.type,
          session: new Headers(init.headers).get(expectedMutationSessionHeader),
        });
      }
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      capabilities: ["task-marks-v1"],
      fetch,
      webSocketFactory: host.connect,
    });
    try {
      await client.load();
      const scope = client.connection.getSnapshot().scope!;
      const hostSessionId = client.getSnapshot().sessionId!;
      const threadId = host.client.getSnapshot().threads[0]!.id;

      await expect(
        client.dispatch(
          { type: "thread.icon.set", threadId, icon: "star", idempotencyKey: "icon_stale" },
          { expectedLogin: { ...scope, loginId: crypto.randomUUID() } },
        ),
      ).rejects.toMatchObject({ failure: { reason: "session-changed" } });
      expect(sent).toEqual([]);

      await client.dispatch(
        { type: "thread.icon.set", threadId, icon: "star", idempotencyKey: "icon_live" },
        { expectedLogin: scope },
      );
      expect(sent).toEqual([{ type: "thread.icon.set", session: hostSessionId }]);
    } finally {
      client.dispose();
      host.dispose();
    }
  });

  it("preserves scoped mutations across an inline same-session shell history repair", async () => {
    const host = new MockPersonalHost();
    const sent: { readonly type: string; readonly session: string | null }[] = [];
    let rewrittenEpoch: string | null = null;
    let repaired = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch") && typeof init?.body === "string") {
        const command = JSON.parse(init.body) as { type: string };
        sent.push({
          type: command.type,
          session: new Headers(init.headers).get(expectedMutationSessionHeader),
        });
      }
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      capabilities: [],
      fetch,
      webSocketFactory: () => {
        const socket = host.connect();
        const deliver = socket.deliver.bind(socket);
        socket.deliver = (frame) => {
          if (
            rewrittenEpoch &&
            frame.type === "host.snapshot" &&
            "subscriptionId" in frame &&
            frame.subscriptionId === "shell"
          ) {
            repaired = true;
            return deliver({
              ...frame,
              snapshot: { ...(frame.snapshot as Record<string, unknown>), epoch: rewrittenEpoch },
            } as typeof frame);
          }
          deliver(frame);
        };
        return socket as unknown as WebSocketClient;
      },
    });
    try {
      await client.load();
      const scope = client.connection.getSnapshot().scope!;
      const hostSessionId = client.getSnapshot().sessionId!;

      // Inline history repair on the same open socket (same viewer and session, new epoch).
      rewrittenEpoch = crypto.randomUUID();
      host.repairShell();
      await vi.waitFor(() => expect(repaired).toBe(true));
      expect(client.getSnapshot().sessionId).toBe(hostSessionId);
      expect(client.connection.getSnapshot().phase).toBe("ready");
      expect(client.connection.getSnapshot().scope).toEqual(scope);

      const seed = host.client.getSnapshot();
      const harness = seed.harnesses[0]!;
      const created = await client.createThread(
        {
          accessMode: seed.executionPreferences.accessMode,
          environmentId: harness.environmentId,
          harnessInstanceId: harness.id,
          modelSelection: seed.threads[0]!.modelSelection,
          title: "Post-repair task",
        },
        scope,
      );
      expect(created.title).toBe("Post-repair task");
      expect(sent.find(({ type }) => type === "thread.create")).toEqual({
        type: "thread.create",
        session: hostSessionId,
      });
    } finally {
      client.dispose();
      host.dispose();
    }
  });

  it("still honors a 401 and queued preference writes across a same-session shell repair", async () => {
    const host = new MockPersonalHost();
    let rewrittenEpoch: string | null = null;
    let repaired = false;
    const heldFirstRemember = Promise.withResolvers<void>();
    const held401 = Promise.withResolvers<Response>();
    let rememberCount = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/machines.list")) return held401.promise;
      if (url.pathname.endsWith("/commands.dispatch") && typeof init?.body === "string") {
        const command = JSON.parse(init.body) as { type: string };
        if (command.type === "execution.preferences.remember" && ++rememberCount === 1) {
          await heldFirstRemember.promise;
        }
      }
      return host.fetch(input, init);
    };
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      capabilities: [],
      fetch,
      webSocketFactory: () => {
        const socket = host.connect();
        const deliver = socket.deliver.bind(socket);
        socket.deliver = (frame) => {
          if (
            rewrittenEpoch &&
            frame.type === "host.snapshot" &&
            "subscriptionId" in frame &&
            frame.subscriptionId === "shell"
          ) {
            repaired = true;
            return deliver({
              ...frame,
              snapshot: { ...(frame.snapshot as Record<string, unknown>), epoch: rewrittenEpoch },
            } as typeof frame);
          }
          deliver(frame);
        };
        return socket as unknown as WebSocketClient;
      },
    });
    try {
      await client.load();
      const readInFlight = client.rpc["machines.list"]({});
      const firstRemember = client.rememberExecution({ accessMode: "approval-required" });
      const secondRemember = client.rememberExecution({ accessMode: "auto" });
      await vi.waitFor(() => expect(rememberCount).toBe(1));

      // Same-session inline history repair while both the read and preference queue are in flight.
      rewrittenEpoch = crypto.randomUUID();
      host.repairShell();
      await vi.waitFor(() => expect(repaired).toBe(true));

      heldFirstRemember.resolve();
      await expect(firstRemember).resolves.toMatchObject({ accessMode: "approval-required" });
      await expect(secondRemember).resolves.toMatchObject({ accessMode: "auto" });
      expect(rememberCount).toBe(2);

      // An in-flight 401 from the same session still expires the session after the repair.
      held401.resolve(
        Response.json(
          { ok: false, error: { code: "unauthorized", message: "Signed out", retryable: false } },
          { status: 401 },
        ),
      );
      await readInFlight;
      expect(client.getSnapshot().session).toBe("authentication-required");
    } finally {
      heldFirstRemember.resolve();
      held401.resolve(Response.json({ ok: true, data: { machines: [] } }));
      client.dispose();
      host.dispose();
    }
  });
});
