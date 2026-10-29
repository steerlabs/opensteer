import { createContext, runInContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { browserPagePolicyScriptFor } from "./page-policy.js";

function fixture(initialPopup = false) {
  class CredentialsContainer {}
  const native = vi.fn().mockResolvedValue("native");
  Object.defineProperties(CredentialsContainer.prototype, {
    create: { value: native, writable: true, configurable: true },
    get: { value: native, writable: true, configurable: true },
  });
  const credentials = Object.create(CredentialsContainer.prototype) as {
    get(input: unknown): Promise<unknown>;
    create(input: unknown): Promise<unknown>;
  };
  const root: Record<string, unknown> = {
    CredentialsContainer,
    Credential: class Credential {},
    navigator: { credentials },
    isSecureContext: true,
    location: { href: "https://example.test/", protocol: "https:" },
    document: {},
    opener: initialPopup ? {} : null,
    crypto: { randomUUID },
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    DOMException,
    AbortSignal,
  };
  if (initialPopup) root.location = { href: "about:blank", protocol: "about:" };
  const context = createContext(root);
  const install = () =>
    runInContext(
      browserPagePolicyScriptFor({ bindingName: "secret-binding", replyName: "reply-slot" }),
      context,
    );
  install();
  const sent: { op: string; id: string; options?: { challenge: string } }[] = [];
  const bind = () => {
    root["secret-binding"] = (payload: string) =>
      sent.push(JSON.parse(payload) as (typeof sent)[number]);
  };
  const reply = () => {
    const request = sent[0]!;
    (root["reply-slot"] as (payload: unknown) => void)({
      id: request.id,
      error: "NotAllowedError",
      message: "The passkey request is not allowed.",
    });
  };
  const success = (created = false, length = 8, idLength = 3) => {
    const request = sent[0]!;
    const bytes = Buffer.alloc(length, 1).toString("base64url");
    (root["reply-slot"] as (payload: unknown) => void)({
      id: request.id,
      credential: {
        id: Buffer.alloc(idLength, 1).toString("base64url"),
        rawId: Buffer.alloc(idLength, 1).toString("base64url"),
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: bytes,
          authenticatorData: bytes,
          ...(created
            ? {
                attestationObject: bytes,
                publicKey: bytes,
                publicKeyAlgorithm: -7,
                transports: ["internal"],
              }
            : { signature: bytes, userHandle: "AQID" }),
        },
      },
    });
  };
  return { success, credentials, native, root, install, sent, bind, reply };
}
afterEach(() => vi.useRealTimers());
it("waits for a function binding, captures it at call time, and removes the global", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.root["secret-binding"] = 7;
  const result = f.credentials
    .get({ publicKey: { challenge: new Uint8Array([1, 2]) } })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.sent).toEqual([]);
  f.bind();
  await vi.advanceTimersByTimeAsync(10);
  expect(f.root["secret-binding"]).toBeUndefined();
  expect(f.sent).toHaveLength(1);
  f.reply();
  expect(await result).toBeInstanceOf(DOMException);
});
it("fails closed within three seconds when a binding never becomes callable", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.root["secret-binding"] = {};
  const result = f.credentials
    .get({ publicKey: { challenge: new Uint8Array([1]) } })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await result).toMatchObject({ name: "NotAllowedError" });
  expect(vi.getTimerCount()).toBe(0);
});
it("is idempotent and forwards other credential requests to the native method", async () => {
  const f = fixture();
  const method = f.credentials.get;
  f.install();
  expect(f.credentials.get).toBe(method);
  expect(await f.credentials.get({ password: true, publicKey: undefined })).toBe("native");
  expect(f.native).toHaveBeenCalledOnce();
});
it("copies a BufferSource view synchronously and ignores unknown dictionary members", async () => {
  const f = fixture();
  f.bind();
  const bytes = new Uint8Array([7, 1, 2, 8]);
  const input = { challenge: new DataView(bytes.buffer, 1, 2), unknown: undefined as unknown };
  input.unknown = input;
  const result = f.credentials.get({ publicKey: input }).catch((error: unknown) => error);
  bytes.fill(0);
  expect(f.sent[0]?.options?.challenge).toBe("AQI");
  f.reply();
  await result;
});
it("rejects abort with the reason object and cancels the matching request", async () => {
  const f = fixture();
  f.bind();
  const controller = new AbortController();
  const reason = { synthetic: true };
  const result = f.credentials
    .get({ publicKey: { challenge: new Uint8Array([1]) }, signal: controller.signal })
    .catch((error: unknown) => error);
  controller.abort(reason);
  expect(await result).toBe(reason);
  expect(f.sent[1]).toEqual({ op: "cancel", id: f.sent[0]!.id });
});

it("reads the publicKey dictionary member once", async () => {
  const f = fixture();
  f.bind();
  const publicKey = vi.fn(() => ({ challenge: new Uint8Array([1]) }));
  const options = Object.defineProperty({}, "publicKey", { get: publicKey });
  const result = f.credentials.get(options).catch((error: unknown) => error);
  f.reply();
  await result;
  expect(publicKey).toHaveBeenCalledOnce();
});

it("bounds a lost bridge reply independently and sends cancellation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.bind();
  const result = f.credentials
    .get({ publicKey: { challenge: new Uint8Array([1]), timeout: 1 } })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toMatchObject({ name: "NotAllowedError" });
  expect(f.sent[1]).toEqual({ op: "cancel", id: f.sent[0]!.id });
  expect(vi.getTimerCount()).toBe(0);
});

type TestCredential = {
  rawId: ArrayBuffer;
  response: Record<string, ArrayBuffer>;
  toJSON(): { rawId: string; response: Record<string, string> };
};
it.each([false, true])(
  "hydrates large response fields and maximum credential IDs (attestation %s)",
  async (created) => {
    const f = fixture();
    f.bind();
    const result = f.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
    f.success(created, 4096, 1023);
    const credential = (await result) as TestCredential;
    expect(credential.response.clientDataJSON!.byteLength).toBe(4096);
    expect(credential.rawId.byteLength).toBe(1023);
    if (created) expect(credential.response.attestationObject!.byteLength).toBe(4096);
  },
);
it("observes abort even when an earlier listener stops propagation", async () => {
  const f = fixture();
  f.bind();
  const controller = new AbortController();
  const reason = { synthetic: true };
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const result = f.credentials
    .get({ publicKey: { challenge: new Uint8Array([1]) }, signal: controller.signal })
    .catch((error: unknown) => error);
  controller.abort(reason);
  f.reply();
  expect(await result).toBe(reason);
  expect(f.sent[1]).toEqual({ op: "cancel", id: f.sent[0]!.id });
});
it.each([false, true])(
  "toJSON encodes current buffers into fresh objects (attestation %s)",
  async (created) => {
    const f = fixture();
    f.bind();
    const result = f.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
    f.success(created);
    const credential = (await result) as TestCredential;
    new Uint8Array(credential.rawId).fill(2);
    for (const member of [
      "clientDataJSON",
      "authenticatorData",
      "signature",
      "userHandle",
      "attestationObject",
    ]) {
      const buffer = credential.response[member];
      if (buffer) new Uint8Array(buffer).fill(3);
    }
    const json = credential.toJSON();
    expect(json.rawId).toBe(Buffer.from(credential.rawId).toString("base64url"));
    for (const member of [
      "clientDataJSON",
      "authenticatorData",
      "signature",
      "userHandle",
      "attestationObject",
    ]) {
      const buffer = credential.response[member];
      if (buffer) expect(json.response[member]).toBe(Buffer.from(buffer).toString("base64url"));
    }
    expect(credential.toJSON()).not.toBe(json);
    expect(credential.toJSON().response).not.toBe(json.response);
  },
);
it.each(["parseCreationOptionsFromJSON", "parseRequestOptionsFromJSON"])(
  "%s distinguishes malformed encoding from shape errors",
  (method) => {
    const f = fixture();
    const constructor = f.root.PublicKeyCredential as Record<string, (input: unknown) => unknown>;
    const valid = {
      challenge: "AQID",
      rp: { name: "Example relying party" },
      user: { id: "AQID", name: "person@example.test", displayName: "Example Person" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    };
    for (const challenge of ["%", "A", "AA=", "_x"])
      expect(() => constructor[method]!({ ...valid, challenge })).toThrowError(
        expect.objectContaining({ name: "EncodingError" }),
      );
    expect(() =>
      constructor[method]!({
        ...valid,
        [method === "parseCreationOptionsFromJSON" ? "excludeCredentials" : "allowCredentials"]: [
          { type: "public-key", id: "%" },
        ],
      }),
    ).toThrowError(expect.objectContaining({ name: "EncodingError" }));
    expect(() => constructor[method]!({})).toThrowError(
      expect.objectContaining({ name: "TypeError" }),
    );
    if (method === "parseCreationOptionsFromJSON")
      expect(() =>
        constructor[method]!({ ...valid, user: { ...valid.user, id: "%" } }),
      ).toThrowError(expect.objectContaining({ name: "EncodingError" }));
  },
);

it("pins the popup guard to the initial Document, not a reused Window realm", async () => {
  const f = fixture(true);
  f.bind();
  await expect(
    f.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } }),
  ).rejects.toMatchObject({ name: "NotAllowedError" });
  f.root.location = { href: "https://example.test/rewritten", protocol: "https:" };
  await expect(
    f.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } }),
  ).rejects.toMatchObject({ name: "NotAllowedError" });
  f.root.document = {};
  const pending = f.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  expect(f.sent).toHaveLength(1);
  f.success();
  await pending;
});
