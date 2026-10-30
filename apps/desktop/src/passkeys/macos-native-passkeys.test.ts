import { EventEmitter } from "node:events";
import type { BaseWindow } from "electron";
import { afterEach, expect, test, vi } from "vitest";
import {
  buildAuthenticatorData,
  buildNoneAttestationObject,
  encodeCoseP256Key,
  PublicKeyCredentialCreationOptionsJSONSchema,
  PublicKeyCredentialRequestOptionsJSONSchema,
  serializeClientData,
} from "@opensteer/browser-runtime-core/passkeys";
import type { NativePasskeyRequest } from "./native-passkeys.js";
import {
  buildMacosPasskeyRequest,
  createMacosNativePasskeys,
  mapMacosPasskeyError,
  mapMacosPasskeyResult,
} from "./macos-native-passkeys.js";

function request(op: "create" | "get" = "create"): NativePasskeyRequest {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.alloc(8),
  }) as unknown as BaseWindow;
  const base = {
    operationId: "ceremony",
    origin: "https://example.com",
    rpId: "example.com",
    deadline: Date.now() + 1000,
    window,
  };
  return op === "create"
    ? {
        ...base,
        op,
        options: PublicKeyCredentialCreationOptionsJSONSchema.parse({
          rp: { name: "Example" },
          user: { id: "AQ", name: "account", displayName: "Account" },
          challenge: "Ag",
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        }),
      }
    : {
        ...base,
        op,
        options: PublicKeyCredentialRequestOptionsJSONSchema.parse({ challenge: "Ag" }),
      };
}
const x = Buffer.from("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", "hex");
const y = Buffer.from("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", "hex");
function result(r: NativePasskeyRequest) {
  const rawClientDataJSON = Buffer.from(
    serializeClientData({ type: `webauthn.${r.op}`, challenge: "Ag", origin: r.origin }),
  ).toString("base64");
  const auth = buildAuthenticatorData({
    rpId: r.rpId,
    flags: 0x41,
    signCount: 0,
    attested: { credentialId: Buffer.from([1]), publicKey: encodeCoseP256Key(x, y) },
  });
  return {
    kind: "created",
    provider: "platform",
    attachment: "platform",
    credentialID: "AQ==",
    rawClientDataJSON,
    rawAttestationObject: buildNoneAttestationObject(auth).toString("base64"),
    transports: null,
  };
}
function seam() {
  let callback: (value: unknown) => void = () => {};
  const addon = {
    available: () => true,
    capabilities: () => ({ securityKeys: true }),
    windowNumber: () => 7,
    start: vi.fn((_json: string, cb: (value: unknown) => void) => {
      callback = cb;
    }),
    cancel: vi.fn(),
  };
  return { addon, complete: (value: unknown) => callback(JSON.stringify(value)) };
}
afterEach(() => vi.useRealTimers());

test("eligibility respects OS, attachment, ES256 and security-key parameters", () => {
  const r = request();
  if (r.op !== "create") throw Error();
  for (const [attachment, alg, keys, expected] of [
    [undefined, -7, true, ["platform", "security-key"]],
    ["platform", -7, true, ["platform"]],
    ["cross-platform", -7, true, ["security-key"]],
    [undefined, -257, true, ["security-key"]],
    [undefined, -7, false, ["platform"]],
    ["cross-platform", -7, false, []],
    ["platform", -257, true, []],
  ] as const) {
    r.options.authenticatorSelection.authenticatorAttachment = attachment;
    r.options.pubKeyCredParams = [{ type: "public-key", alg }];
    expect(buildMacosPasskeyRequest(r, 7, keys).providers).toEqual(expected);
  }
  r.options.pubKeyCredParams = [];
  r.options.authenticatorSelection.authenticatorAttachment = undefined;
  expect(buildMacosPasskeyRequest(r, 7, true).providers).toEqual([]);
});

test("cross-platform registration offers nearby phones only when the RP hints hybrid", () => {
  const r = request();
  if (r.op !== "create") throw Error();
  r.options.authenticatorSelection.authenticatorAttachment = "cross-platform";
  r.options.pubKeyCredParams = [{ type: "public-key", alg: -7 }];
  // The platform sheet can always save a local passkey, which this attachment forbids.
  expect(buildMacosPasskeyRequest(r, 7, true).providers).toEqual(["security-key"]);
  expect(buildMacosPasskeyRequest(r, 7, false).providers).toEqual([]);
  // Nearby phones are offered only through the platform request.
  r.options.hints = ["hybrid"];
  expect(buildMacosPasskeyRequest(r, 7, true)).toMatchObject({
    providers: ["platform", "security-key"],
    shouldShowHybridTransport: true,
  });
  expect(buildMacosPasskeyRequest(r, 7, false).providers).toEqual(["platform"]);
  r.options.hints = ["security-key", "hybrid"];
  expect(buildMacosPasskeyRequest(r, 7, true).providers).toEqual(["security-key"]);
  r.options.hints = ["hybrid"];
  r.options.pubKeyCredParams = [{ type: "public-key", alg: -257 }];
  expect(buildMacosPasskeyRequest(r, 7, true).providers).toEqual(["security-key"]);
});

test("refuses a local passkey for a cross-platform registration", () => {
  const r = request();
  if (r.op !== "create") throw Error();
  r.options.authenticatorSelection.authenticatorAttachment = "cross-platform";
  r.options.hints = ["hybrid"];
  const raw = result(r);
  expect(
    mapMacosPasskeyResult(r, { ...raw, provider: "platform", attachment: "cross-platform" }),
  ).toMatchObject({ kind: "created", authenticatorAttachment: "cross-platform" });
  // A local result, or one whose attachment the OS does not report, is not a roaming credential.
  for (const attachment of ["platform", null] as const)
    expect(() => mapMacosPasskeyResult(r, { ...raw, provider: "platform", attachment })).toThrow(
      "attachment",
    );
  expect(
    mapMacosPasskeyResult(r, { ...raw, provider: "security-key", attachment: null }),
  ).toMatchObject({ kind: "created" });
});

test("maps challenge, identity, deadlines, UV, resident key, exclusions and none attestation", () => {
  const r = request();
  if (r.op !== "create") throw Error();
  r.options.authenticatorSelection.userVerification = "required";
  r.options.authenticatorSelection.residentKey = "required";
  r.options.attestation = "direct";
  r.options.excludeCredentials = [
    { type: "public-key", id: Buffer.from([9]), transports: ["usb"] },
    { type: "future", id: Buffer.from([8]), transports: undefined },
  ];
  expect(buildMacosPasskeyRequest(r, 7, true)).toMatchObject({
    operationId: r.operationId,
    origin: r.origin,
    rpId: r.rpId,
    deadline: r.deadline,
    windowNumber: 7,
    challenge: "Ag==",
    userVerification: "required",
    residentKey: "required",
    attestation: "none",
    shouldShowHybridTransport: true,
    credentials: [{ id: "CQ==", transports: ["usb"] }],
    algorithms: [-7],
    user: { id: "AQ==", name: "account", displayName: "Account" },
  });
});

test("assertion keeps allow lists restrictive and hybrid follows transports", () => {
  const r = request("get");
  if (r.op !== "get") throw Error();
  expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(true);
  r.options.allowCredentials = [{ type: "public-key", id: Buffer.from([9]), transports: ["usb"] }];
  r.options.userVerification = "discouraged";
  expect(buildMacosPasskeyRequest(r, 7, true)).toMatchObject({
    shouldShowHybridTransport: false,
    userVerification: "discouraged",
    credentials: [{ id: "CQ==", transports: ["usb"] }],
  });
  r.options.allowCredentials[0]!.transports = ["hybrid"];
  expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(true);
  r.options.allowCredentials[0]!.type = "future";
  expect(buildMacosPasskeyRequest(r, 7, true).providers).toEqual([]);
});

test("maps hybrid attachment, transport fallbacks, discoverability and verbatim native bytes", () => {
  const r = request();
  const raw = result(r);
  expect(mapMacosPasskeyResult(r, { ...raw, attachment: "cross-platform" })).toMatchObject({
    kind: "created",
    authenticatorAttachment: "cross-platform",
    transports: ["internal", "hybrid"],
    discoverable: true,
    publicKeyAlgorithm: -7,
  });
  expect(
    mapMacosPasskeyResult(r, { ...raw, provider: "security-key", attachment: "cross-platform" }),
  ).toMatchObject({ transports: [], discoverable: null });
  expect(mapMacosPasskeyResult(r, { ...raw, transports: ["usb"] })).toMatchObject({
    transports: ["usb"],
    clientDataJSON: Buffer.from(raw.rawClientDataJSON, "base64"),
    attestationObject: Buffer.from(raw.rawAttestationObject, "base64"),
  });
  if (r.op === "create") r.options.authenticatorSelection.residentKey = "required";
  expect(mapMacosPasskeyResult(r, { ...raw, provider: "security-key" })).toMatchObject({
    discoverable: true,
  });
  const get = request("get");
  expect(
    mapMacosPasskeyResult(get, {
      kind: "asserted",
      provider: "platform",
      attachment: "cross-platform",
      credentialID: "AQ==",
      rawClientDataJSON: Buffer.from(
        serializeClientData({ type: "webauthn.get", challenge: "Ag", origin: get.origin }),
      ).toString("base64"),
      rawAuthenticatorData: Buffer.alloc(37, 1).toString("base64"),
      signature: "Ag==",
      userID: "",
    }),
  ).toMatchObject({
    kind: "asserted",
    signature: Buffer.from([2]),
    userHandle: null,
    authenticatorAttachment: "cross-platform",
  });
});

test.each([
  ["ASAuthorizationError", 1001, "create", "NotAllowedError"],
  ["com.apple.AuthenticationServices.AuthorizationError", 1006, "create", "InvalidStateError"],
  ["WKErrorDomain", 8, "create", "InvalidStateError"],
  ["WKErrorDomain", 8, "get", "NotAllowedError"],
  ["other", 1006, "create", "NotAllowedError"],
  ["com.apple.AuthenticationServices.AuthorizationError", 1006, "get", "NotAllowedError"],
] as const)("checks native error domain/code/operation %s %s %s", (domain, code, op, error) => {
  expect(mapMacosPasskeyError(op, domain, code)).toEqual({ kind: "refused", error });
});

test.each([
  { type: "webauthn.get" },
  { challenge: "Aw" },
  { origin: "https://other.example" },
  { crossOrigin: true },
])("refuses mismatched client data %j", (change) => {
  const r = request();
  const raw = result(r);
  raw.rawClientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge: "Ag",
      origin: r.origin,
      crossOrigin: false,
      ...change,
    }),
  ).toString("base64");
  expect(() => mapMacosPasskeyResult(r, raw)).toThrow();
});

test("settles once, discards late callbacks and cancels on abort before native cancellation", async () => {
  const s = seam();
  const r = request();
  const abort = new AbortController();
  const adapter = createMacosNativePasskeys({ platform: "darwin", load: () => s.addon });
  s.addon.cancel.mockImplementation(() => s.complete(result(r)));
  const promise = adapter.perform(r, abort.signal);
  abort.abort();
  expect(await promise).toEqual({ kind: "refused", error: "AbortError" });
  s.complete(result(r));
  expect(s.addon.cancel).toHaveBeenCalledExactlyOnceWith(r.operationId);
  expect(r.window.listenerCount("closed")).toBe(0);
});

test.each(["deadline", "window"])("cancels and ignores late success on %s", async (ending) => {
  vi.useFakeTimers();
  const s = seam();
  const r = request();
  const adapter = createMacosNativePasskeys({ platform: "darwin", load: () => s.addon });
  const promise = adapter.perform(r, new AbortController().signal);
  if (ending === "deadline") await vi.advanceTimersByTimeAsync(1001);
  else r.window.emit("closed");
  expect(await promise).toEqual({ kind: "refused", error: "NotAllowedError" });
  s.complete(result(r));
  expect(s.addon.cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("checks deadline again when callback beats the timer, rejects malformed replies and cleans up success", async () => {
  vi.useFakeTimers();
  const s = seam();
  const r = request();
  const adapter = createMacosNativePasskeys({ platform: "darwin", load: () => s.addon });
  const promise = adapter.perform(r, new AbortController().signal);
  vi.setSystemTime(r.deadline);
  s.complete(result(r));
  expect(await promise).toEqual({ kind: "refused", error: "NotAllowedError" });
  const next = { ...r, deadline: Date.now() + 1000 };
  const malformed = adapter.perform(next, new AbortController().signal);
  s.complete({ ...result(next), credentialID: "not base64!" });
  expect(await malformed).toEqual({ kind: "refused", error: "NotAllowedError" });
  const success = adapter.perform(next, new AbortController().signal);
  s.complete(result(next));
  expect(await success).toMatchObject({ kind: "created" });
  expect(vi.getTimerCount()).toBe(0);
});

test("availability fails closed off macOS, on load failure, malformed ABI or missing entitlement", async () => {
  const load = vi.fn(() => {
    throw Error("missing");
  });
  expect(createMacosNativePasskeys({ platform: "linux", load }).available()).toBe(false);
  expect(load).not.toHaveBeenCalled();
  expect(createMacosNativePasskeys({ platform: "darwin", load }).available()).toBe(false);
  expect(
    createMacosNativePasskeys({
      platform: "darwin",
      load: () => ({ available: () => "yes" }),
    }).available(),
  ).toBe(false);
  const s = seam();
  s.addon.available = () => false;
  const adapter = createMacosNativePasskeys({ platform: "darwin", load: () => s.addon });
  expect(adapter.available()).toBe(false);
  expect(await adapter.perform(request(), new AbortController().signal)).toEqual({
    kind: "refused",
    error: "NotAllowedError",
  });
  expect(s.addon.start).not.toHaveBeenCalled();
});

test("RP hints suppress hybrid unless hybrid is among the recognized hints", () => {
  const r = request();
  r.options.hints = ["security-key"];
  expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(false);
  r.options.hints = ["hybrid"];
  expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(true);
});

test("rejects pre-aborted, expired and closed requests without starting native work", async () => {
  const s = seam();
  const adapter = createMacosNativePasskeys({ platform: "darwin", load: () => s.addon });
  const abort = new AbortController();
  abort.abort();
  expect(await adapter.perform(request(), abort.signal)).toEqual({
    kind: "refused",
    error: "AbortError",
  });
  const expired = { ...request(), deadline: Date.now() };
  expect(await adapter.perform(expired, new AbortController().signal)).toEqual({
    kind: "refused",
    error: "NotAllowedError",
  });
  const closed = request();
  vi.spyOn(closed.window, "isDestroyed").mockReturnValue(true);
  expect(await adapter.perform(closed, new AbortController().signal)).toEqual({
    kind: "refused",
    error: "NotAllowedError",
  });
  expect(s.addon.start).not.toHaveBeenCalled();
});

test("a duplicate operation cannot replace a live request, and native errors log only domain/code", async () => {
  const s = seam();
  const r = request();
  const log = vi.fn();
  const adapter = createMacosNativePasskeys({ platform: "darwin", load: () => s.addon, log });
  const pending = adapter.perform(r, new AbortController().signal);
  expect(await adapter.perform(r, new AbortController().signal)).toEqual({
    kind: "refused",
    error: "NotAllowedError",
  });
  s.complete({
    kind: "error",
    domain: "com.apple.AuthenticationServices.AuthorizationError",
    code: 1006,
    message: "ignored",
  });
  expect(await pending).toEqual({ kind: "refused", error: "InvalidStateError" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "com.apple.AuthenticationServices.AuthorizationError",
    1006,
  );
  expect(s.addon.start).toHaveBeenCalledOnce();
});

test("an unknown-type entry never broadens a mixed allow list", () => {
  const r = request("get");
  if (r.op !== "get") throw Error();
  r.options.allowCredentials = [
    { type: "future", id: Buffer.from([1]), transports: undefined },
    { type: "public-key", id: Buffer.from([2]), transports: undefined },
  ];
  expect(buildMacosPasskeyRequest(r, 1, false)).toMatchObject({
    providers: ["platform"],
    credentials: [{ id: "Ag==", transports: [] }],
  });
});

test.each(["create", "get"] as const)(
  "%s applies ordered hints before contradictory USB transports",
  (op) => {
    const r = request(op);
    const descriptors = [
      { type: "public-key", id: Buffer.from([9]), transports: ["usb"] as const },
    ];
    if (r.op === "create")
      r.options.excludeCredentials = descriptors.map((d) => ({
        ...d,
        transports: [...d.transports],
      }));
    else
      r.options.allowCredentials = descriptors.map((d) => ({
        ...d,
        transports: [...d.transports],
      }));
    r.options.hints = ["hybrid"];
    expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(true);
    for (const hints of [
      ["security-key", "hybrid"],
      ["client-device", "hybrid"],
    ] as const) {
      r.options.hints = [...hints];
      expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(false);
    }
    r.options.hints = ["hybrid", "security-key"];
    expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(true);
  },
);

test("an explicit hybrid hint takes precedence over the registration attachment default", () => {
  const r = request("create");
  if (r.op !== "create") throw Error();
  r.options.authenticatorSelection.authenticatorAttachment = "platform";
  r.options.hints = ["hybrid"];
  expect(buildMacosPasskeyRequest(r, 7, true).shouldShowHybridTransport).toBe(true);
});
