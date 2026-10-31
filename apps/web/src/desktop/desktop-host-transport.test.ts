import { bootstrapDiagnosticHeader } from "@opensteer/shared/bootstrapDiagnostics";
import type {
  DesktopHostWebSocketEvent,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopHostFetch,
  createDesktopHostWebSocketFactory,
} from "./desktop-host-transport.js";

describe("Desktop Host renderer adapter", () => {
  it("closes before binding and waits for main's terminal event", async () => {
    const fixture = socketFixture();
    const socket = fixture.create();
    const closed = vi.fn();
    const opened = vi.fn();
    socket.addEventListener("close", closed);
    socket.addEventListener("open", opened);
    socket.close(4_002, "Invalid frame");
    expect(socket.readyState).toBe(2);
    expect(fixture.bridge.closeHostWebSocket).not.toHaveBeenCalled();
    await fixture.bind();
    expect(fixture.bridge.closeHostWebSocket).toHaveBeenCalledExactlyOnceWith({
      connectionId: fixture.connectionId,
      code: 4_002,
      reason: "Invalid frame",
    });
    expect(closed).not.toHaveBeenCalled();
    fixture.receive({ type: "open" });
    fixture.receive({ type: "close", code: 4_002, reason: "Invalid frame" });
    fixture.receive({ type: "close", code: 1_006, reason: "late" });
    expect(opened).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
  });

  it("preserves a close behind more than 64 frames before bind and consumes the buffer", async () => {
    const fixture = socketFixture();
    const socket = fixture.create();
    const closed = vi.fn();
    const messages = vi.fn();
    socket.addEventListener("close", closed);
    socket.addEventListener("message", messages);
    fixture.receive({ type: "open" });
    for (let index = 0; index < 80; index += 1)
      fixture.receive({ type: "text", data: String(index) });
    fixture.receive({ type: "close", code: 4_001, reason: "Deployment changed" });
    fixture.receive({ type: "text", data: "late" });
    await fixture.bind();
    expect(socket.readyState).toBe(3);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed.mock.calls[0]![0]).toMatchObject({ code: 4_001, reason: "Deployment changed" });
    expect(messages).toHaveBeenCalledTimes(63);
    const replacement = fixture.create();
    fixture.receive({ type: "open" });
    await fixture.bind();
    expect(replacement.readyState).toBe(1);
  });

  it.each([
    "main-close",
    "early-main-close",
    "rejected-close",
    "failed-send-main-close",
    "failed-send-rejected-close",
  ])("releases registry ownership after %s", async (termination) => {
    const fixture = socketFixture();
    const socket = fixture.create();
    const closed = vi.fn();
    const messages = vi.fn();
    socket.addEventListener("close", closed);
    socket.addEventListener("message", messages);
    if (termination === "early-main-close")
      fixture.receive({ type: "close", code: 4_001, reason: "Deployment changed" });
    await fixture.bind();
    if (termination !== "early-main-close") {
      fixture.receive({ type: "open" });
      if (termination.includes("rejected-close"))
        vi.mocked(fixture.bridge.closeHostWebSocket).mockRejectedValueOnce(
          new Error("Unknown socket"),
        );
      if (termination.startsWith("failed-send")) {
        vi.mocked(fixture.bridge.sendHostWebSocket).mockRejectedValueOnce(new Error("IPC failed"));
        socket.send("subscribe");
      } else if (termination === "rejected-close") socket.close();
      else fixture.receive({ type: "close", code: 1_000, reason: "Host stopped" });
    }
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    if (termination === "failed-send-main-close")
      fixture.receive({ type: "close", code: 4_002, reason: "Desktop bridge failed" });
    if (!termination.includes("rejected-close"))
      fixture.receive({ type: "close", code: 1_006, reason: "late" });
    fixture.receive({ type: "text", data: "late" });
    socket.close();
    expect(closed).toHaveBeenCalledOnce();
    expect(messages).not.toHaveBeenCalled();
    const replacement = fixture.create();
    fixture.receive({ type: "open" });
    await fixture.bind();
    expect(replacement.readyState).toBe(1);
  });

  it("retains a closing socket until main closes it, including synchronous closure during bind", async () => {
    const fixture = socketFixture();
    vi.mocked(fixture.bridge.closeHostWebSocket).mockImplementation(async () => {
      fixture.receive({ type: "close", code: 1_005, reason: "" });
    });
    const socket = fixture.create();
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    socket.close();
    await fixture.bind();
    expect(socket.readyState).toBe(3);
    expect(closed).toHaveBeenCalledOnce();
    const replacement = fixture.create();
    fixture.receive({ type: "open" });
    await fixture.bind();
    expect(replacement.readyState).toBe(1);
  });

  it("streams a file preview with a long key through a bounded POST body", async () => {
    const bridge = {
      hostBinaryOpen: vi.fn(async () => ({
        ok: true,
        data: { transferId: "00000000-0000-4000-8000-000000000001" },
      })),
      hostBinaryRead: vi.fn(async () => ({
        ok: true,
        data: {
          bytes: new TextEncoder().encode("0123456789"),
          contentType: "text/plain",
          done: true,
          etag: '"preview"',
          fileSizeBytes: 100,
          fileTruncated: true,
          lastModified: null,
          sizeBytes: 10,
          status: 200,
        },
      })),
      hostBinaryClose: vi.fn(async () => ({ ok: true, data: null })),
    } as unknown as OpensteerDesktopBridge;
    const fetch = createDesktopHostFetch(bridge, "https://home.connect.opensteer.test");
    const body = JSON.stringify({ fileKey: "a".repeat(5_462), workspaceId: "wsp_test" });
    const response = await fetch(
      "https://home.connect.opensteer.test/v1/rpc/workspace.files.preview",
      {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(bridge.hostBinaryOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        body,
        method: "POST",
        path: "/v1/rpc/workspace.files.preview",
      }),
    );
    expect(await response.text()).toBe("0123456789");
    expect(response.headers.get("etag")).toBe('"preview"');
    expect(response.headers.get("x-opensteer-file-size")).toBe("100");
    expect(response.headers.get("x-opensteer-file-truncated")).toBe("true");
  });

  it("converts selected-origin fetches into typed bridge requests", async () => {
    const hostRequest = vi.fn(async () => ({
      ok: true,
      data: {
        body: '{"ok":true}',
        headers: { contentType: "application/json" },
        status: 200,
      },
    }));
    const fetch = createDesktopHostFetch(
      { hostRequest } as unknown as OpensteerDesktopBridge,
      "https://home.connect.opensteer.test",
    );

    const response = await fetch("https://home.connect.opensteer.test/v1/workspaces?limit=10", {
      body: '{"name":"Home"}',
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": "workspace:test",
      },
      method: "POST",
    });

    expect(hostRequest).toHaveBeenCalledWith({
      body: '{"name":"Home"}',
      headers: {
        accept: "application/json",
        contentType: "application/json",
        idempotencyKey: "workspace:test",
      },
      method: "POST",
      path: "/v1/workspaces?limit=10",
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("relays bootstrap summaries through the existing request bridge", async () => {
    const hostRequest = vi.fn(async () => ({
      ok: true,
      data: { body: "{}", headers: { contentType: "application/json" }, status: 200 },
    }));
    const fetch = createDesktopHostFetch(
      { hostRequest } as unknown as OpensteerDesktopBridge,
      "https://home.test",
    );
    const summary = JSON.stringify({ windowMs: 3000, triggers: { load: 6 }, starts: { load: 6 } });
    await fetch("https://home.test/v1/rpc/bootstrap.get", {
      headers: { [bootstrapDiagnosticHeader]: summary },
    });
    expect(hostRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ bootstrapDiagnostics: summary }),
      }),
    );
  });

  it("rejects cross-Deployment requests and renderer-controlled privileged headers", async () => {
    const fetch = createDesktopHostFetch(
      { hostRequest: vi.fn() } as unknown as OpensteerDesktopBridge,
      "https://home.connect.opensteer.test",
    );

    await expect(fetch("https://attacker.test/v1/bootstrap")).rejects.toThrow(
      "other than the selected Deployment",
    );
    await expect(
      fetch("https://home.connect.opensteer.test/v1/bootstrap", {
        headers: { authorization: "Bearer renderer-controlled" },
      }),
    ).rejects.toThrow("cannot set the Host header authorization");
  });

  it("adapts sockets through one bridge listener and rejects cross-Deployment targets", async () => {
    const connectionId = "desktop_host_socket_00000000-0000-4000-8000-000000000001";
    let receive: ((event: DesktopHostWebSocketEvent) => void) | null = null;
    const onHostWebSocketEvent = vi.fn((listener) => {
      receive = listener;
      return () => undefined;
    });
    const bridge = {
      closeHostWebSocket: vi.fn(async () => undefined),
      onHostWebSocketEvent,
      openHostWebSocket: vi.fn(async () => ({ connectionId })),
      sendHostWebSocket: vi.fn(async () => undefined),
    } as unknown as OpensteerDesktopBridge;
    const firstFactory = createDesktopHostWebSocketFactory(
      bridge,
      "https://home.connect.opensteer.test",
    );
    createDesktopHostWebSocketFactory(bridge, "https://home.connect.opensteer.test");
    expect(onHostWebSocketEvent).toHaveBeenCalledTimes(1);
    expect(() => firstFactory("wss://attacker.test/v1/realtime")).toThrow("another Deployment");

    const socket = firstFactory("wss://home.connect.opensteer.test/v1/realtime");
    const opened = vi.fn();
    socket.addEventListener("open", opened);
    await vi.waitFor(() => expect(bridge.openHostWebSocket).toHaveBeenCalled());
    receive!({ connectionId, type: "open" });
    expect(opened).toHaveBeenCalledTimes(1);
    socket.send("subscribe");
    await vi.waitFor(() =>
      expect(bridge.sendHostWebSocket).toHaveBeenCalledWith({
        connectionId,
        data: "subscribe",
        type: "text",
      }),
    );
    vi.mocked(bridge.sendHostWebSocket).mockRejectedValueOnce(new Error("IPC closed"));
    socket.send("second message");
    await vi.waitFor(() =>
      expect(bridge.closeHostWebSocket).toHaveBeenCalledWith({
        code: 4_002,
        connectionId,
        reason: "Desktop bridge failed",
      }),
    );
  });

  // A phone's live display arrives at up to 30 frames a second; each frame
  // already reached this renderer as its own copy over IPC.
  it("hands a binary frame's own buffer to the socket instead of copying it again", async () => {
    const connectionId = "desktop_host_socket_00000000-0000-4000-8000-000000000002";
    let receive: ((event: DesktopHostWebSocketEvent) => void) | null = null;
    const bridge = {
      closeHostWebSocket: vi.fn(async () => undefined),
      onHostWebSocketEvent: vi.fn((listener) => {
        receive = listener;
        return () => undefined;
      }),
      openHostWebSocket: vi.fn(async () => ({ connectionId })),
      sendHostWebSocket: vi.fn(async () => undefined),
    } as unknown as OpensteerDesktopBridge;
    const socket = createDesktopHostWebSocketFactory(
      bridge,
      "https://binary.connect.opensteer.test",
    )("wss://binary.connect.opensteer.test/v1/computer-use/sessions/cus_1/display");
    socket.binaryType = "arraybuffer";
    const received: unknown[] = [];
    socket.addEventListener("message", ({ data }) => received.push(data));
    await vi.waitFor(() => expect(bridge.openHostWebSocket).toHaveBeenCalled());
    receive!({ connectionId, type: "open" });
    const frame = new Uint8Array([0, 0, 0, 1, 0x65]);
    receive!({ connectionId, type: "binary", data: frame });
    expect(received[0]).toBe(frame.buffer);
    // A view into a larger buffer is copied to exactly its bytes, never shared whole.
    const larger = new Uint8Array([9, 0, 0, 0, 1, 0x41, 9]);
    receive!({ connectionId, type: "binary", data: larger.subarray(1, 6) });
    expect(received[1]).not.toBe(larger.buffer);
    expect(Array.from(new Uint8Array(received[1] as ArrayBuffer))).toEqual([0, 0, 0, 1, 0x41]);
  });
});

function socketFixture() {
  const connectionId = "desktop_host_socket_00000000-0000-4000-8000-000000000003";
  let receive: ((event: DesktopHostWebSocketEvent) => void) | null = null;
  const openings: ReturnType<typeof Promise.withResolvers<{ connectionId: string }>>[] = [];
  const bridge = {
    closeHostWebSocket: vi.fn(async () => undefined),
    onHostWebSocketEvent: vi.fn((listener) => {
      receive = listener;
      return () => undefined;
    }),
    openHostWebSocket: vi.fn(() => {
      const pending = Promise.withResolvers<{ connectionId: string }>();
      openings.push(pending);
      return pending.promise;
    }),
    sendHostWebSocket: vi.fn(async () => undefined),
  } as unknown as OpensteerDesktopBridge;
  const factory = createDesktopHostWebSocketFactory(bridge, "https://home.connect.opensteer.test");
  return {
    bridge,
    connectionId,
    create: () => factory("wss://home.connect.opensteer.test/v1/realtime"),
    bind: async () => {
      openings.shift()!.resolve({ connectionId });
      await Promise.resolve();
      await Promise.resolve();
    },
    receive: (
      event: DesktopHostWebSocketEvent extends infer Event
        ? Event extends { connectionId: string }
          ? Omit<Event, "connectionId">
          : never
        : never,
    ) => receive!({ connectionId, ...event }),
  };
}
