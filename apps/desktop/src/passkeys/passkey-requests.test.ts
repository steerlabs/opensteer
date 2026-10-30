import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { BaseWindow, WebContents } from "electron";
import type { PasskeyAuthenticatorOutcome } from "@opensteer/browser-runtime-core/passkeys";
import { DesktopPasskeyRequests } from "./passkey-requests.js";
import type { DesktopBrowserControlObservation } from "../connections/host-transport.js";
import { PasskeyTestAuthenticator } from "@opensteer/browser-runtime-core/test-support/passkey-test-authenticator";
const requestId = "e2799da2-9fe9-438e-a160-47e275ee2703";
const successful = {
  kind: "asserted",
  credentialId: new Uint8Array([1]),
  clientDataJSON: new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: "AQID",
      origin: "https://login.example.test",
      crossOrigin: false,
    }),
  ),
  authenticatorData: new Uint8Array([2]),
  signature: new Uint8Array([3]),
  userHandle: null,
  authenticatorAttachment: "platform",
} satisfies PasskeyAuthenticatorOutcome;
function fixture(nativeView = false) {
  let binding: object | "streamed" | null = nativeView ? {} : "streamed";
  let presentationChanged = () => {};
  let observe: (event: DesktopBrowserControlObservation) => void = () => {};
  const sent: unknown[] = [];
  const contents = Object.assign(new EventEmitter(), { id: 7 });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents,
  });
  const resolveWindow = vi.fn<(contents: WebContents) => BaseWindow | null>(
    () => window as unknown as BaseWindow,
  );
  const perform = vi.fn<import("./native-passkeys.js").NativePasskeys["perform"]>();
  const service = new DesktopPasskeyRequests({
    presentations: {
      passkeyBinding: () => binding,
      observePasskeyPresentation: (listener: () => void) => {
        presentationChanged = listener;
        return () => {};
      },
    },
    native: { available: () => true, perform },
    ownOrigins: () => ["https://deployment.test"],
    windowForContents: resolveWindow,
    transport: {
      observeBrowserControl: (listener) => {
        observe = listener;
        return () => {};
      },
      sendBrowserControl: (_owner, _connection, message) => {
        sent.push(message);
      },
    },
  });
  service.attachWindow(window as unknown as BaseWindow & { webContents: WebContents });
  const base = {
    ownerId: 7,
    connectionId: "socket",
    sessionId: "bsn_e2799da2-9fe9-438e-a160-47e275ee2703",
    mode: "control" as const,
  };
  const emit = (event: object) =>
    observe({ ...base, ...event } as DesktopBrowserControlObservation);
  emit({ type: "admitted" });
  emit({
    type: "message",
    message: { type: "browser.snapshot", passkeys: "native", passkeyConsumerToken: requestId },
  });
  emit({ type: "presentation", surfaceId: "tab" });
  const request = {
    type: "browser.passkey.request",
    requestId,
    ceremonyId: requestId,
    surfaceId: "tab",
    documentId: "document",
    op: "get",
    origin: "https://login.example.test",
    rpId: "example.test",
    options: {
      challenge: "AQID",
      allowCredentials: [],
      userVerification: "preferred",
      extensions: {},
    },
    clientDataJSON: "AQID",
    cause: { person: requestId },
    deadline: Date.now() + 10_000,
  };
  return {
    changePresentation: (next: object | "streamed" | null) => {
      binding = next;
      presentationChanged();
    },
    service,
    sent,
    emit,
    request,
    perform,
    window,
    contents: contents as unknown as WebContents,
    resolveWindow,
  };
}
it("refuses unknown IDs and resolves the presenting window before the native call", async () => {
  const f = fixture();
  f.perform.mockImplementation((request, signal) =>
    new PasskeyTestAuthenticator().ceremony({ ...request, signal }),
  );
  await expect(f.service.present(f.contents, requestId)).rejects.toThrow();
  f.emit({ type: "message", message: f.request });
  await vi.waitFor(() => expect(f.perform).toHaveBeenCalledTimes(1));
  expect(f.resolveWindow).toHaveBeenCalledWith(f.contents);
  expect(f.perform.mock.calls[0]![0].window).toBe(f.window);
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  f.service.dispose();
});
it.each(["closed", "reload", "socket", "presentation"])(
  "cancels and settles promptly on %s",
  async (ending) => {
    const f = fixture();
    let finish: (outcome: PasskeyAuthenticatorOutcome) => void = () => {};
    f.perform.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.emit({ type: "message", message: f.request });
    await vi.waitFor(() => expect(f.perform).toHaveBeenCalledTimes(1));
    if (ending === "closed") f.window.emit("closed");
    if (ending === "reload")
      f.contents.emit("did-start-navigation", {}, "app://opensteer/", false, true);
    if (ending === "socket") f.emit({ type: "closed" });
    if (ending === "presentation") f.emit({ type: "presentation", surfaceId: "other" });
    expect(f.perform.mock.calls[0]![1].aborted).toBe(true);
    finish(successful);
    await Promise.resolve();
    expect(f.sent).toEqual([{ type: "passkey.cancel", requestId }]);
    await expect(f.service.present(f.contents, requestId)).rejects.toThrow();
    f.service.dispose();
  },
);
it("claims an offer only after Continue and rejects own sites and dead windows", async () => {
  const f = fixture();
  f.emit({
    type: "message",
    message: {
      type: "browser.passkey.offer",
      requestId,
      surfaceId: "tab",
      op: "get",
      rpId: "example.test",
      deadline: f.request.deadline,
    },
  });
  expect(f.perform).not.toHaveBeenCalled();
  await f.service.present(f.contents, requestId);
  expect(f.sent).toEqual([{ type: "passkey.claim", requestId }]);
  f.emit({ type: "message", message: { ...f.request, origin: "https://deployment.test" } });
  expect(f.perform).not.toHaveBeenCalled();
  f.service.dispose();
});
it("rejects a forged client data result and a missing presentation window", async () => {
  const f = fixture();
  f.resolveWindow.mockReturnValueOnce(null);
  f.emit({ type: "message", message: f.request });
  expect(f.perform).not.toHaveBeenCalled();
  expect(f.sent).toContainEqual({ type: "passkey.cancel", requestId });
  f.service.dispose();
  const second = fixture();
  second.perform.mockResolvedValue({
    kind: "asserted",
    credentialId: new Uint8Array([1]),
    clientDataJSON: new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: "AQID",
        origin: "https://other.test",
        crossOrigin: false,
      }),
    ),
    authenticatorData: new Uint8Array([2]),
    signature: new Uint8Array([3]),
    userHandle: null,
    authenticatorAttachment: "platform",
  });
  second.emit({ type: "message", message: second.request });
  await vi.waitFor(() =>
    expect(second.sent).toContainEqual({
      type: "passkey.respond",
      requestId,
      outcome: { kind: "refused", error: "NotAllowedError" },
    }),
  );
  second.service.dispose();
});
it("never forwards native success after the deadline", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let finish: (value: PasskeyAuthenticatorOutcome) => void = () => {};
    f.perform.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.emit({ type: "message", message: f.request });
    vi.advanceTimersByTime(10_001);
    finish(successful);
    await Promise.resolve();
    expect(f.perform.mock.calls[0]![1].aborted).toBe(true);
    expect(f.sent).toEqual([{ type: "passkey.cancel", requestId }]);
    f.service.dispose();
  } finally {
    vi.useRealTimers();
  }
});
it("lets either presenting window claim the same offer without sharing request ownership", async () => {
  const f = fixture();
  const contents = Object.assign(new EventEmitter(), { id: 8 });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents,
  });
  f.service.attachWindow(window as unknown as BaseWindow & { webContents: WebContents });
  f.resolveWindow.mockImplementation((sender) =>
    sender.id === 8 ? (window as unknown as BaseWindow) : (f.window as unknown as BaseWindow),
  );
  const second = { ownerId: 8, connectionId: "second" };
  f.emit({ ...second, type: "admitted" });
  f.emit({
    ...second,
    type: "message",
    message: { type: "browser.snapshot", passkeys: "native", passkeyConsumerToken: requestId },
  });
  f.emit({ ...second, type: "presentation", surfaceId: "tab" });
  const offer = {
    type: "browser.passkey.offer",
    requestId,
    surfaceId: "tab",
    op: "get",
    rpId: "example.test",
    deadline: f.request.deadline,
  };
  f.emit({ type: "message", message: offer });
  f.emit({ ...second, type: "message", message: offer });
  await f.service.present(contents as unknown as WebContents, requestId);
  await f.service.present(f.contents, requestId);
  expect(f.sent).toEqual([
    { type: "passkey.claim", requestId },
    { type: "passkey.claim", requestId },
  ]);
  f.emit({ ...second, type: "message", message: { type: "browser.passkey.withdrawn", requestId } });
  await expect(f.service.present(contents as unknown as WebContents, requestId)).rejects.toThrow();
  await expect(f.service.present(f.contents, requestId)).resolves.toBeUndefined();
  f.service.dispose();
});

it("round trips an empty normalized algorithm set without restoring page defaults", async () => {
  const {
    PublicKeyCredentialCreationOptionsJSONSchema,
    PasskeyCeremonySchema,
    BrowserPasskeyRequestSchema,
    passkeyBytesToJSON,
  } = await import("@opensteer/protocol/passkeys");
  const f = fixture();
  const software = new PasskeyTestAuthenticator();
  f.perform.mockImplementation((request, signal) => software.ceremony({ ...request, signal }));
  const options = PublicKeyCredentialCreationOptionsJSONSchema.parse({
    rp: { name: "Example" },
    user: { id: "AQID", name: "person@example.test", displayName: "Example" },
    challenge: "AQID",
    pubKeyCredParams: [{ type: "future-credential", alg: -7 }],
  });
  expect(options.pubKeyCredParams).toEqual([]);
  try {
    const ceremony = PasskeyCeremonySchema.parse(
      JSON.parse(
        JSON.stringify({
          ...f.request,
          type: "passkey.ceremony",
          requestId: undefined,
          op: "create",
          options: passkeyBytesToJSON(options),
        }),
      ),
    );
    expect(ceremony.options).toMatchObject({ pubKeyCredParams: [] });
    const request = BrowserPasskeyRequestSchema.parse(
      JSON.parse(JSON.stringify({ ...ceremony, type: "browser.passkey.request", requestId })),
    );
    f.emit({ type: "message", message: request });
    await vi.waitFor(() =>
      expect(f.sent).toEqual([
        {
          type: "passkey.respond",
          requestId,
          outcome: { kind: "refused", error: "NotSupportedError" },
        },
      ]),
    );
    expect(f.perform.mock.calls[0]![0].options).toMatchObject({ pubKeyCredParams: [] });
  } finally {
    f.service.dispose();
  }
});

it.each(["release", "replacement", "failure"])(
  "cancels a native-view request on presentation %s while its socket stays subscribed",
  async (ending) => {
    const f = fixture(true);
    let complete: (outcome: PasskeyAuthenticatorOutcome) => void = () => {};
    f.perform.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    try {
      f.emit({ type: "message", message: f.request });
      await vi.waitFor(() => expect(f.perform).toHaveBeenCalledTimes(1));
      f.changePresentation(ending === "replacement" ? {} : null);
      expect(f.perform.mock.calls[0]![1].aborted).toBe(true);
      complete(successful);
      await Promise.resolve();
      expect(f.sent).toEqual([{ type: "passkey.cancel", requestId }]);
      await expect(f.service.present(f.contents, requestId)).rejects.toThrow();
    } finally {
      f.service.dispose();
    }
  },
);
