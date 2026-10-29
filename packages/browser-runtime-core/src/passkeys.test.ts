import { expect, it } from "vitest";
import { resolveRpId, serializeClientData } from "./passkeys/index.js";
it("binds RP IDs to canonical secure origins and private suffixes", () => {
  expect(resolveRpId("https://a.example.com", "example.com")).toEqual({ rpId: "example.com" });
  for (const origin of [
    "http://example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://example.com/",
  ])
    expect(resolveRpId(origin)).toEqual({ error: "SecurityError" });
  expect(resolveRpId("https://a.github.io", "github.io")).toEqual({ error: "SecurityError" });
});
it("serializes control characters using CCDToString, never short escapes", () => {
  expect(
    Buffer.from(
      serializeClientData({ type: "webauthn.create", challenge: "AA", origin: 'a\n\t\u0000"\\' }),
    ).toString(),
  ).toBe(
    '{"type":"webauthn.create","challenge":"AA","origin":"a\\u000a\\u0009\\u0000\\"\\\\","crossOrigin":false}',
  );
});

import { createECDH, createHash, createPrivateKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { decodeBase64Url, encodeBase64Url } from "@opensteer/shared/base64url";
import {
  PublicKeyCredentialCreationOptionsJSONSchema as Creation,
  PublicKeyCredentialRequestOptionsJSONSchema as Request,
  encodeCoseP256Key,
  encodePasskeyCbor,
  buildAuthenticatorData,
  buildAuthenticationResponseJSON,
  buildNoneAttestationObject,
  buildRegistrationResponseJSON,
} from "./passkeys/index.js";
import { PasskeyTestAuthenticator } from "./test-support/passkey-test-authenticator.js";
const b64 = (n: number) => encodeBase64Url(new Uint8Array(n).fill(42));
const creation = {
  rp: { name: "Example", id: "example.com" },
  user: { id: b64(16), name: "person@example.test", displayName: "Example Person" },
  challenge: b64(32),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  extensions: { credProps: true, prf: {} },
};
it("parses and bounds JSON options and strips unsupported extensions", () => {
  const parsed = Creation.parse(creation);
  expect(parsed.user.id).toHaveLength(16);
  expect(parsed.extensions).toEqual({ credProps: true });
  for (const size of [1, 64])
    expect(
      Creation.safeParse({ ...creation, user: { ...creation.user, id: b64(size) } }).success,
    ).toBe(true);
  for (const id of ["", b64(65), "AB", "AA=="])
    expect(Creation.safeParse({ ...creation, user: { ...creation.user, id } }).success).toBe(false);
  for (const size of [1, 1024])
    expect(Request.safeParse({ challenge: b64(size) }).success).toBe(true);
  for (const challenge of ["", b64(1025)])
    expect(Request.safeParse({ challenge }).success).toBe(false);
  const descriptor = { id: b64(1023), type: "public-key" };
  expect(
    Request.parse({ challenge: "AA", allowCredentials: Array(64).fill(descriptor) })
      .allowCredentials,
  ).toHaveLength(64);
  for (const allowCredentials of [Array(65).fill(descriptor), [{ ...descriptor, id: b64(1024) }]])
    expect(Request.safeParse({ challenge: "AA", allowCredentials }).success).toBe(false);
  for (const bad of [
    { ...creation, rp: {} },
    { ...creation, user: {} },
    { ...creation, rp: { name: "x".repeat(1025) } },
  ])
    expect(Creation.safeParse(bad).success).toBe(false);
});
it("resolves label boundaries, ports and IDN with private PSL boundaries", () => {
  for (const [origin, rpId] of [
    ["https://a.example.co.uk", "example.co.uk"],
    ["https://a.github.io", "a.github.io"],
    ["https://xn--bcher-kva.de:8443", "bücher.de"],
  ])
    expect(resolveRpId(origin!, rpId!)).toEqual({
      rpId: rpId === "bücher.de" ? "xn--bcher-kva.de" : rpId,
    });
  for (const [origin, rpId] of [
    ["https://example.com", "evil.com"],
    ["https://badexample.com", "example.com"],
    ["https://a.co.uk", "co.uk"],
    ["https://github.io", "github.io"],
    ["https://example.com.", "example.com"],
    ["https://[::1]", undefined],
    ["https://bücher.de", undefined],
    ["https://example.com", "example.com/path"],
  ])
    expect(resolveRpId(origin!, rpId)).toEqual({ error: "SecurityError" });
});
it("pins canonical CBOR integers, map ordering, COSE and none attestation", () => {
  expect(
    encodePasskeyCbor(
      new Map([
        ["b", 1],
        ["a", -7],
      ]),
    ).toString("hex"),
  ).toBe("a2616126616201");
  const cose = encodeCoseP256Key(new Uint8Array(32), new Uint8Array(32).fill(1));
  expect(cose.toString("hex")).toBe(
    "a5010203262001215820" + "00".repeat(32) + "225820" + "01".repeat(32),
  );
  expect(buildNoneAttestationObject(new Uint8Array([1, 2])).toString("hex")).toBe(
    "a363666d74646e6f6e656761747453746d74a0686175746844617461420102",
  );
  expect(
    buildAuthenticatorData({ rpId: "example.com", flags: 13, signCount: 0 }).toString("hex"),
  ).toBe(createHash("sha256").update("example.com").digest("hex") + "0d00000000");
});
it("is accepted by an independent L3 verifier with truthful backup/counter semantics", async () => {
  const authenticator = new PasskeyTestAuthenticator();
  const clientDataJSON = serializeClientData({
    type: "webauthn.create",
    challenge: creation.challenge,
    origin: "https://example.com",
  });
  const registered = authenticator.create(Creation.parse(creation), "example.com", clientDataJSON);
  const result = await verifyRegistrationResponse({
    response: registered,
    expectedChallenge: creation.challenge,
    expectedOrigin: "https://example.com",
    expectedRPID: "example.com",
    requireUserVerification: true,
  });
  expect(result.verified).toBe(true);
  expect(result.registrationInfo).toMatchObject({
    credentialBackedUp: false,
    credentialDeviceType: "multiDevice",
    credential: { counter: 0 },
    aaguid: "dd9443d6-4875-44f3-a68d-5d17076af9c5",
  });
  const asserted = authenticator.get(
    Request.parse({ challenge: creation.challenge }),
    "example.com",
    serializeClientData({
      type: "webauthn.get",
      challenge: creation.challenge,
      origin: "https://example.com",
    }),
  );
  const auth = await verifyAuthenticationResponse({
    response: asserted,
    expectedChallenge: creation.challenge,
    expectedOrigin: "https://example.com",
    expectedRPID: "example.com",
    requireUserVerification: true,
    credential: result.registrationInfo!.credential,
  });
  expect(auth.verified).toBe(true);
  expect(auth.authenticationInfo).toMatchObject({
    credentialBackedUp: false,
    credentialDeviceType: "multiDevice",
    newCounter: 0,
  });
  expect(() =>
    authenticator.create(
      Creation.parse({
        ...creation,
        excludeCredentials: [{ id: registered.id, type: "public-key" }],
      }),
      "example.com",
      clientDataJSON,
    ),
  ).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
  for (const options of [
    { challenge: "AA", allowCredentials: [{ id: "AA", type: "public-key" }] },
    { challenge: "AA" },
  ])
    expect(() => authenticator.get(Request.parse(options), "other.com", clientDataJSON)).toThrow(
      expect.objectContaining({ name: "NotAllowedError" }),
    );
  expect(registered.id).toHaveLength(22);
  const tampered = { ...asserted, response: { ...asserted.response, authenticatorData: b64(37) } };
  await expect(
    verifyAuthenticationResponse({
      response: tampered,
      expectedChallenge: creation.challenge,
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      requireUserVerification: true,
      credential: result.registrationInfo!.credential,
    }),
  ).rejects.toThrow();
});
it("pins reproducible Swift crypto vectors (OPENSTEER_WRITE_PASSKEY_FIXTURE=1 rewrites)", () => {
  const ec = createECDH("prime256v1");
  ec.setPrivateKey(Buffer.from("00".repeat(31) + "01", "hex"));
  const point = ec.getPublicKey();
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: encodeBase64Url(Buffer.from(ec.getPrivateKey().toString("hex").padStart(64, "0"), "hex")),
    x: encodeBase64Url(point.subarray(1, 33)),
    y: encodeBase64Url(point.subarray(33)),
  };
  const credentialId = new Uint8Array(16).fill(7);
  const authenticator = new PasskeyTestAuthenticator({ privateKeyJwk: jwk, credentialId });
  const clientData = serializeClientData({
    type: "webauthn.create",
    challenge: creation.challenge,
    origin: "https://example.com",
  });
  const registration = authenticator.create(Creation.parse(creation), "example.com", clientData);
  const assertionClientData = serializeClientData({
    type: "webauthn.get",
    challenge: creation.challenge,
    origin: "https://example.com",
  });
  const assertion = authenticator.get(
    Request.parse({ challenge: creation.challenge }),
    "example.com",
    assertionClientData,
  );
  const vector = {
    rpId: "example.com",
    origin: "https://example.com",
    challenge: creation.challenge,
    user: creation.user,
    credentialId: registration.id,
    privateKeyJwk: jwk,
    privateKeyPkcs8: encodeBase64Url(
      createPrivateKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "pkcs8" }),
    ),
    registration,
    assertion: {
      clientDataJSON: assertion.response.clientDataJSON,
      authenticatorData: assertion.response.authenticatorData,
      userHandle: assertion.response.userHandle,
      signatureBase: encodeBase64Url(
        Buffer.concat([
          decodeBase64Url(assertion.response.authenticatorData),
          createHash("sha256").update(assertionClientData).digest(),
        ]),
      ),
    },
  };
  const path = new URL("./test-support/fixtures/passkeys-vectors.json", import.meta.url);
  if (process.env.OPENSTEER_WRITE_PASSKEY_FIXTURE === "1")
    writeFileSync(
      path,
      JSON.stringify(
        { ...vector, assertion: { ...vector.assertion, signature: assertion.response.signature } },
        null,
        2,
      ) + "\n",
    );
  const fixture = JSON.parse(readFileSync(path, "utf8")) as typeof vector & {
    assertion: { signature: string };
  };
  const { signature, ...assertionFields } = fixture.assertion;
  expect({ ...fixture, assertion: assertionFields }).toEqual(vector);
  // ECDSA signatures are randomized; pin a valid DER example while comparing
  // the reproducible signing input byte for byte across languages.
  expect(
    verify(
      "sha256",
      decodeBase64Url(vector.assertion.signatureBase),
      createPrivateKey({ key: jwk, format: "jwk" }),
      decodeBase64Url(signature),
    ),
  ).toBe(true);
});

it("rejects localhost subdomains and URL-escaped RP IDs", () => {
  expect(resolveRpId("https://app.localhost")).toEqual({ error: "SecurityError" });
  expect(resolveRpId("https://example.com", "exa%6dple.com")).toEqual({ error: "SecurityError" });
});

it("offers an authenticator port that preserves supplied raw client data", async () => {
  const authenticator: import("./passkeys/index.js").PasskeyAuthenticator =
    new PasskeyTestAuthenticator();
  const options = Creation.parse(creation);
  // A system authenticator may serialize differently; the bridge must return
  // exactly the client data it actually used, including additional members.
  const raw = Buffer.from(
    '{"type":"webauthn.create","challenge":"AA","origin":"https://example.com","crossOrigin":false,"extra":1}',
  );
  const result = await authenticator.ceremony({
    op: "create",
    origin: "https://example.com",
    rpId: "example.com",
    options,
    signal: new AbortController().signal,
    clientDataJSON: raw,
  });
  expect(result.kind).toBe("created");
  if (result.kind !== "created") throw new Error("Expected registration");
  expect(Buffer.from(result.clientDataJSON)).toEqual(raw);
  const asserted = await authenticator.ceremony({
    op: "get",
    origin: "https://example.com",
    rpId: "example.com",
    options: Request.parse({ challenge: creation.challenge }),
    signal: new AbortController().signal,
  });
  expect(asserted.kind).toBe("asserted");
  if (asserted.kind !== "asserted") throw new Error("Expected assertion");
  expect(Buffer.from(asserted.clientDataJSON)).toEqual(
    serializeClientData({
      type: "webauthn.get",
      origin: "https://example.com",
      challenge: creation.challenge,
    }),
  );
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await authenticator.ceremony({
      op: "get",
      origin: "https://example.com",
      rpId: "example.com",
      options: Request.parse({ challenge: "AA" }),
      signal: aborted.signal,
    }),
  ).toEqual({ kind: "refused", error: "AbortError" });
});

it("uses every CCDToString control escape and preserves ordinary Unicode and slash", () => {
  const controls = String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i));
  const expected =
    "\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\u0008\\u0009\\u000a\\u000b\\u000c\\u000d\\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f";
  expect(
    Buffer.from(
      serializeClientData({
        type: "webauthn.get",
        challenge: "AA",
        origin: controls + "bücher/\u2028",
      }),
    ).toString("utf8"),
  ).toBe(
    '{"type":"webauthn.get","challenge":"AA","origin":"' +
      expected +
      'bücher/\u2028","crossOrigin":false}',
  );
});
it("reports unsupported algorithms and allow-list misses through the port", async () => {
  const authenticator = new PasskeyTestAuthenticator();
  const signal = new AbortController().signal;
  const base = { origin: "https://example.com", rpId: "example.com", signal };
  expect(
    await authenticator.ceremony({
      ...base,
      op: "create",
      options: Creation.parse({
        ...creation,
        pubKeyCredParams: [{ type: "public-key", alg: -257 }],
      }),
    }),
  ).toEqual({ kind: "refused", error: "NotSupportedError" });
  const created = authenticator.create(
    Creation.parse(creation),
    "example.com",
    serializeClientData({
      type: "webauthn.create",
      challenge: creation.challenge,
      origin: base.origin,
    }),
  );
  expect(created.clientExtensionResults).toEqual({ credProps: { rk: true } });
  expect(
    await authenticator.ceremony({
      ...base,
      op: "get",
      options: Request.parse({
        challenge: "AA",
        allowCredentials: [{ type: "public-key", id: "AA" }],
      }),
    }),
  ).toEqual({ kind: "refused", error: "NotAllowedError" });
  const assertion = authenticator.get(
    Request.parse({ challenge: "AA" }),
    "example.com",
    serializeClientData({ type: "webauthn.get", challenge: "AA", origin: base.origin }),
  );
  expect(assertion.clientExtensionResults).toEqual({});
  expect(() => buildAuthenticatorData({ rpId: "example.com", flags: 16, signCount: 0 })).toThrow(
    "Unsupported authenticator flags/counter",
  );
});
it("normalizes options the way L3 does instead of rejecting them", () => {
  expect(Creation.parse({ ...creation, pubKeyCredParams: [] }).pubKeyCredParams).toEqual([
    { type: "public-key", alg: -7 },
    { type: "public-key", alg: -257 },
  ]);
  // A listed but unknown credential type is skipped, not replaced by the defaults.
  expect(
    Creation.parse({ ...creation, pubKeyCredParams: [{ type: "future", alg: -7 }] })
      .pubKeyCredParams,
  ).toEqual([]);
  const future = Creation.parse({
    ...creation,
    user: { ...creation.user, displayName: "" },
    rp: { ...creation.rp, name: "" },
    attestation: "future",
    authenticatorSelection: {
      authenticatorAttachment: "future",
      residentKey: "future",
      requireResidentKey: true,
      userVerification: "future",
    },
  });
  expect(future.user.displayName).toBe("");
  expect(future.attestation).toBe("none");
  expect(future.authenticatorSelection).toEqual({
    authenticatorAttachment: undefined,
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "preferred",
  });
  const request = Request.parse({
    challenge: "AA",
    userVerification: "future",
    allowCredentials: [{ type: "future", id: "AA", transports: ["usb", "future"] }],
  });
  expect(request.userVerification).toBe("preferred");
  // The unknown descriptor keeps the allow list non-empty, so it never means "any credential".
  expect(request.allowCredentials).toEqual([
    { type: "future", id: new Uint8Array([0]), transports: ["usb"] },
  ]);
});
it("refuses an allow list of unknown descriptor types instead of discovering any credential", async () => {
  const authenticator = new PasskeyTestAuthenticator();
  const clientDataJSON = new Uint8Array([1]);
  const registered = authenticator.create(Creation.parse(creation), "example.com", clientDataJSON);
  expect(() =>
    authenticator.get(
      Request.parse({ challenge: "AA", allowCredentials: [{ type: "future", id: registered.id }] }),
      "example.com",
      clientDataJSON,
    ),
  ).toThrow(expect.objectContaining({ name: "NotAllowedError" }));
});
it("orders CBOR map keys by major type before length", () => {
  expect(
    encodePasskeyCbor(
      new Map([
        [24, 0],
        [-1, 0],
      ]),
    ).toString("hex"),
  ).toBe("a21818002000");
  expect(
    encodePasskeyCbor(
      new Map<number | string, number>([
        ["a", 0],
        [-1, 0],
        [1, 0],
      ]),
    ).toString("hex"),
  ).toBe("a301002000616100");
});
it("refuses reserved authenticator flag bits", () => {
  for (const flags of [0x03, 0x21])
    expect(() => buildAuthenticatorData({ rpId: "example.com", flags, signCount: 0 })).toThrow(
      "Unsupported authenticator flags/counter",
    );
});
it("builds page JSON from what the authenticator reported", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const created = buildRegistrationResponseJSON(
    {
      kind: "created",
      credentialId: bytes,
      clientDataJSON: bytes,
      authenticatorData: bytes,
      attestationObject: bytes,
      publicKey: null,
      publicKeyAlgorithm: -8,
      authenticatorAttachment: "cross-platform",
      transports: ["hybrid", "internal"],
      discoverable: null,
    },
    { credProps: true },
  );
  expect(created).toEqual({
    id: "AQID",
    rawId: "AQID",
    type: "public-key",
    authenticatorAttachment: "cross-platform",
    clientExtensionResults: { credProps: {} },
    response: {
      clientDataJSON: "AQID",
      attestationObject: "AQID",
      authenticatorData: "AQID",
      publicKeyAlgorithm: -8,
      transports: ["hybrid", "internal"],
    },
  });
  const asserted = buildAuthenticationResponseJSON({
    kind: "asserted",
    credentialId: bytes,
    clientDataJSON: bytes,
    authenticatorData: bytes,
    signature: bytes,
    userHandle: null,
    authenticatorAttachment: null,
  });
  expect(asserted).toEqual({
    id: "AQID",
    rawId: "AQID",
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: "AQID", authenticatorData: "AQID", signature: "AQID" },
  });
});
