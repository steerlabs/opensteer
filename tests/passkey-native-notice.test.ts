import { expect, it, vi } from "vitest";
import {
  HostTransport,
  type HostNetworkSocketEvents,
} from "../packages/client/src/connections/host-transport.js";
import { DesktopHostTransport } from "../apps/desktop/src/connections/host-transport.js";
import { PasskeyService, type PasskeyViewer } from "../apps/host/src/browser/passkey-service.js";
import { HostRelayAuthenticator } from "../packages/browser-runtime-core/src/passkeys/host-relay.js";
import { PublicKeyCredentialRequestOptionsJSONSchema } from "../packages/protocol/src/passkey-options.js";
import { serializeClientData } from "../packages/browser-runtime-core/src/passkeys/index.js";

it("keeps notice-mode native input with that person instead of offering another desktop", async () => {
  const token = "00000000-0000-4000-8000-000000000001";
  const sessionId = "bsn_00000000-0000-4000-8000-000000000002";
  const nativeSocket = { send: vi.fn(), close: vi.fn() };
  let events: HostNetworkSocketEvents | undefined;
  const open = vi
    .spyOn(HostTransport.prototype, "openSocket")
    .mockImplementation(async (_input, observe) => {
      events = observe(nativeSocket);
      return nativeSocket;
    });
  const transport = new DesktopHostTransport({
    catalog: {},
    localRuntime: { current: async () => null },
    network: {},
    projection: {},
  } as unknown as ConstructorParameters<typeof DesktopHostTransport>[0]);
  const local = vi.fn();
  const other = vi.fn();
  const viewers: PasskeyViewer[] = [
    {
      token,
      userId: "person",
      fullControl: true,
      mode: "notice",
      surfaceId: "tab",
      live: true,
      authorized: async () => true,
      send: local,
    },
    {
      token: "00000000-0000-4000-8000-000000000003",
      userId: "person",
      fullControl: true,
      mode: "native",
      surfaceId: "tab",
      live: true,
      authorized: async () => true,
      send: other,
    },
  ];
  const relay = new HostRelayAuthenticator(() => ({
    sessionId,
    surfaceId: "tab",
    send: (message) => {
      if (message.type === "passkey.ceremony") host.ceremony(message);
    },
  }));
  const host = new PasskeyService({
    ownOrigins: () => [],
    viewers: () => viewers,
    result: (message) => relay.result(sessionId, message),
  });
  try {
    const { connectionId } = await transport.openWebSocket(
      7,
      { path: `/v1/browser-sessions/${sessionId}/connect?passkeys=notice` },
      () => {},
    );
    events!.message(
      JSON.stringify({
        type: "browser.snapshot",
        sessionId,
        access: "full-control",
        state: "ready",
        dialog: null,
        surfaces: [
          { id: "tab", active: true, title: "Example", url: "https://login.example.test" },
        ],
        passkeys: "notice",
        passkeyConsumerToken: token,
      }),
    );
    transport.sendWebSocket(7, {
      connectionId,
      type: "text",
      data: JSON.stringify({ type: "stream.subscribe", surfaceId: "tab" }),
    });
    // This is the admitted-consumer lookup used by a native presentation's trusted input hook.
    const consumer = transport.passkeyConsumerToken(7, connectionId, "tab");
    relay.record("target", consumer ? { person: consumer } : "unknown");
    const result = relay.ceremony({
      op: "get",
      options: PublicKeyCredentialRequestOptionsJSONSchema.parse({ challenge: "AQID" }),
      origin: "https://login.example.test",
      rpId: "example.test",
      signal: new AbortController().signal,
      targetId: "target",
      documentId: "document",
      deadline: Date.now() + 1000,
      clientDataJSON: serializeClientData({
        type: "webauthn.get",
        challenge: "AQID",
        origin: "https://login.example.test",
      }),
    });
    expect(other).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledExactlyOnceWith({
      type: "browser.passkey.notice",
      surfaceId: "tab",
    });
    await expect(result).resolves.toEqual({ kind: "refused", error: "NotAllowedError" });
  } finally {
    host.close();
    relay.close();
    transport.closeSocketsForOwner(7);
    open.mockRestore();
  }
});
