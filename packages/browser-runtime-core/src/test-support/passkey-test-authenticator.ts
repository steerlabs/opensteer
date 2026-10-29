import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type webcrypto,
  type KeyObject,
} from "node:crypto";
import { decodeBase64Url, encodeBase64Url } from "@opensteer/shared/base64url";
import {
  buildAuthenticationResponseJSON,
  buildAuthenticatorData,
  buildNoneAttestationObject,
  buildRegistrationResponseJSON,
  encodeCoseP256Key,
  passkeyFlags,
  type PasskeyCreationOptions,
  type PasskeyRequestOptions,
  type PasskeyAuthenticator,
  type PasskeyAuthenticatorInput,
  type PasskeyAuthenticatorOutcome,
  type PasskeyAssertedOutcome,
  type PasskeyCreatedOutcome,
  serializeClientData,
} from "../passkeys/index.js";

/** Software oracle only: its simulated verification must never back a real provider. */
export class PasskeyTestAuthenticator implements PasskeyAuthenticator {
  async ceremony(input: PasskeyAuthenticatorInput): Promise<PasskeyAuthenticatorOutcome> {
    if (input.signal.aborted) return { kind: "refused", error: "AbortError" };
    const clientDataJSON =
      input.clientDataJSON ??
      serializeClientData({
        type: input.op === "create" ? "webauthn.create" : "webauthn.get",
        challenge: encodeBase64Url(input.options.challenge),
        origin: input.origin,
      });
    try {
      return input.op === "create"
        ? this.createOutcome(input.options, input.rpId, clientDataJSON)
        : this.getOutcome(input.options, input.rpId, clientDataJSON);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "InvalidStateError" ||
          error.name === "NotAllowedError" ||
          error.name === "NotSupportedError")
      )
        return { kind: "refused", error: error.name };
      throw error;
    }
  }
  private readonly credentials: {
    id: Uint8Array;
    rpId: string;
    userHandle: Uint8Array;
    key: KeyObject;
  }[] = [];
  private readonly fixed:
    { privateKeyJwk: webcrypto.JsonWebKey; credentialId: Uint8Array } | undefined;
  constructor(fixed?: { privateKeyJwk: webcrypto.JsonWebKey; credentialId: Uint8Array }) {
    this.fixed = fixed;
  }
  create(options: PasskeyCreationOptions, rpId: string, clientDataJSON: Uint8Array) {
    return buildRegistrationResponseJSON(this.createOutcome(options, rpId, clientDataJSON), {
      credProps: options.extensions.credProps === true,
    });
  }
  get(options: PasskeyRequestOptions, rpId: string, clientDataJSON: Uint8Array) {
    return buildAuthenticationResponseJSON(this.getOutcome(options, rpId, clientDataJSON));
  }
  private createOutcome(
    options: PasskeyCreationOptions,
    rpId: string,
    clientDataJSON: Uint8Array,
  ): PasskeyCreatedOutcome {
    if (!options.pubKeyCredParams.some((p) => p.alg === -7))
      throw Object.assign(new Error("ES256 required"), { name: "NotSupportedError" });
    if (
      options.excludeCredentials.some(
        (d) =>
          d.type === "public-key" &&
          this.credentials.some(
            (c) => c.rpId === rpId && encodeBase64Url(c.id) === encodeBase64Url(d.id),
          ),
      )
    )
      throw Object.assign(new Error("Excluded"), { name: "InvalidStateError" });
    const key = this.fixed
      ? createPrivateKey({ key: this.fixed.privateKeyJwk, format: "jwk" })
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const publicKey = createPublicKey(key);
    const jwk = publicKey.export({ format: "jwk" });
    const id = Uint8Array.from(this.fixed?.credentialId ?? randomBytes(16));
    const cose = encodeCoseP256Key(decodeBase64Url(jwk.x!), decodeBase64Url(jwk.y!));
    const authenticatorData = buildAuthenticatorData({
      rpId,
      flags: passkeyFlags.UP | passkeyFlags.UV | passkeyFlags.BE | passkeyFlags.AT,
      signCount: 0,
      attested: { credentialId: id, publicKey: cose },
    });
    this.credentials.push({ id, rpId, userHandle: Uint8Array.from(options.user.id), key });
    return {
      kind: "created",
      credentialId: id,
      clientDataJSON,
      authenticatorData,
      attestationObject: buildNoneAttestationObject(authenticatorData),
      publicKey: publicKey.export({ format: "der", type: "spki" }),
      publicKeyAlgorithm: -7,
      authenticatorAttachment: "platform",
      transports: ["internal"],
      discoverable: true,
    };
  }
  private getOutcome(
    options: PasskeyRequestOptions,
    rpId: string,
    clientDataJSON: Uint8Array,
  ): PasskeyAssertedOutcome {
    const c = this.credentials.find(
      (c) =>
        c.rpId === rpId &&
        (!options.allowCredentials.length ||
          options.allowCredentials.some(
            (d) => d.type === "public-key" && encodeBase64Url(d.id) === encodeBase64Url(c.id),
          )),
    );
    if (!c) throw Object.assign(new Error("No credential"), { name: "NotAllowedError" });
    const authenticatorData = buildAuthenticatorData({
      rpId,
      flags: passkeyFlags.UP | passkeyFlags.UV | passkeyFlags.BE,
      signCount: 0,
    });
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
      c.key,
    );
    return {
      kind: "asserted",
      credentialId: c.id,
      clientDataJSON,
      authenticatorData,
      signature,
      userHandle: c.userHandle,
      authenticatorAttachment: "platform",
    };
  }
}
