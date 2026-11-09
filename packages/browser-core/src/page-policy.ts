/// <reference lib="dom" />

/** Native WebAuthn stays absent, including in documents the provider cannot cover. */
export const browserPageDisabledBlinkFeatures = "WebAuth";
export const browserPagePermissionsPolicy =
  "publickey-credentials-create=(), publickey-credentials-get=()";

export type BrowserPagePolicyConfig =
  { readonly bindingName: string; readonly replyName: string } | undefined;

/** Serialized into both engines; all runtime dependencies must live in this function. */
export function installBrowserPagePolicy(config?: BrowserPagePolicyConfig): void {
  if (!config) {
    if (typeof CredentialsContainer === "undefined") return;
    for (const method of ["create", "get"] as const) {
      const native = CredentialsContainer.prototype[method];
      CredentialsContainer.prototype[method] = new Proxy(native, {
        apply(target, thisArgument, argumentList) {
          const options = argumentList[0];
          // Matches how the browser reads its options dictionary: any object,
          // functions included, and an undefined member counts as absent.
          const dictionary =
            (typeof options === "object" && options !== null) || typeof options === "function";
          if (dictionary && (options as { publicKey?: unknown }).publicKey !== undefined) {
            return Promise.reject(
              new DOMException("Passkeys aren't available in this browser.", "NotAllowedError"),
            );
          }
          return Reflect.apply(target, thisArgument, argumentList);
        },
      });
    }
    return;
  }
  if (!globalThis.isSecureContext || typeof CredentialsContainer === "undefined") return;
  const prototype = CredentialsContainer.prototype;
  const marker = Symbol.for("opensteer.passkeyProvider");
  if (Object.hasOwn(prototype, marker)) return;
  Object.defineProperty(prototype, marker, { value: true });
  const credentials = navigator.credentials;
  // A first same-origin navigation can reuse the initial Window realm. Pin
  // the refusal to its Document: writing changes its URL without a commit.
  const initialPopup = globalThis.opener !== null && location.protocol === "about:";
  const initialPopupDocument = initialPopup ? globalThis.document : null;
  const bindingName = config.bindingName;
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const stringify = JSON.stringify;
  const clone = <T>(value: T): T => JSON.parse(stringify(value)) as T;
  const now = performance.now.bind(performance);
  const schedule = globalThis.setTimeout.bind(globalThis);
  const unschedule = globalThis.clearTimeout.bind(globalThis);
  const uuid = crypto.randomUUID.bind(crypto);
  const replyName = config.replyName;
  const describe = Object.getOwnPropertyDescriptor;
  const Exception = DOMException;
  const dependentSignal = AbortSignal.any.bind(AbortSignal);
  const failure = () => new Exception("The passkey request is not allowed.", "NotAllowedError");
  const malformed = () => new TypeError("Invalid public key credential options.");
  const dictionary = (value: unknown): Record<string, unknown> => {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" && typeof value !== "function") throw malformed();
    return value as Record<string, unknown>;
  };
  const domString = (value: unknown): string => {
    if (typeof value === "symbol") throw malformed();
    return String(value);
  };
  const text = (value: unknown): string => {
    const result = domString(value);
    if (result.length > 1024) throw malformed();
    return result;
  };
  const shortText = (value: unknown): string => {
    const result = text(value);
    if (result.length > 64) throw malformed();
    return result;
  };
  const required = (object: Record<string, unknown>, key: string): unknown => {
    const value = object[key];
    if (value === undefined) throw malformed();
    return value;
  };
  const encode = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  };
  const decode = (value: unknown, maximum: number): ArrayBuffer => {
    const encoded = domString(value);
    const encodingError = () => new Exception("Invalid base64url encoding.", "EncodingError");
    if (!/^[A-Za-z0-9_-]*$/u.test(encoded) || encoded.length % 4 === 1) throw encodingError();
    if (encoded.length > Math.ceil((maximum * 4) / 3)) throw malformed();
    let binary: string;
    try {
      binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    } catch {
      throw encodingError();
    }
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (encode(bytes) !== encoded) throw encodingError();
    if (bytes.byteLength > maximum) throw malformed();
    return bytes.buffer;
  };
  const binary = (value: unknown, max: number, fromJSON: boolean): string => {
    if (fromJSON) value = decode(value, max);
    let bytes: Uint8Array;
    try {
      // The intrinsic accepts buffers from another realm, rejects SharedArrayBuffer
      // and detached buffers, and copies precisely the view's byte range now.
      if (ArrayBuffer.isView(value)) {
        const copy = ArrayBuffer.prototype.slice.call(
          value.buffer,
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ) as ArrayBuffer;
        bytes = new Uint8Array(copy);
      } else {
        bytes = new Uint8Array(ArrayBuffer.prototype.slice.call(value, 0) as ArrayBuffer);
      }
    } catch {
      throw malformed();
    }
    if (bytes.length < 1 || bytes.length > max) throw malformed();
    return encode(bytes);
  };
  const sequence = (value: unknown, maximum = 64): unknown[] => {
    if (typeof value !== "object" || value === null || !(Symbol.iterator in value))
      throw malformed();
    const output: unknown[] = [];
    for (const item of value as Iterable<unknown>) {
      if (output.length >= maximum) throw malformed();
      output.push(item);
    }
    return output;
  };
  const number = (value: unknown): number => {
    if (typeof value === "bigint") throw malformed();
    return Number(value);
  };
  const convert = (
    op: "create" | "get",
    value: unknown,
    fromJSON = false,
  ): Record<string, unknown> => {
    const input = dictionary(value);
    const result: Record<string, unknown> = {
      challenge: binary(required(input, "challenge"), 1024, fromJSON),
    };
    const hints = input.hints;
    if (hints !== undefined) result.hints = sequence(hints, 16).map(shortText);
    const timeout = input.timeout;
    if (timeout !== undefined) result.timeout = number(timeout) >>> 0;
    const descriptors = op === "create" ? "excludeCredentials" : "allowCredentials";
    const descriptorList = input[descriptors];
    if (descriptorList !== undefined)
      result[descriptors] = sequence(descriptorList).map((item) => {
        const descriptor = dictionary(item);
        const transports = descriptor.transports;
        return {
          type: shortText(required(descriptor, "type")),
          id: binary(required(descriptor, "id"), 1023, fromJSON),
          ...(transports === undefined
            ? {}
            : { transports: sequence(transports, 16).map(shortText) }),
        };
      });
    const extensionInput = input.extensions;
    if (extensionInput !== undefined) {
      const credProps = dictionary(extensionInput).credProps;
      result.extensions = credProps === undefined ? {} : { credProps: Boolean(credProps) };
    }
    if (op === "create") {
      const rp = dictionary(required(input, "rp"));
      const user = dictionary(required(input, "user"));
      const rpId = rp.id;
      result.rp = {
        name: text(required(rp, "name")),
        ...(rpId === undefined ? {} : { id: text(rpId) }),
      };
      result.user = {
        id: binary(required(user, "id"), 64, fromJSON),
        name: text(required(user, "name")),
        displayName: text(required(user, "displayName")),
      };
      result.pubKeyCredParams = sequence(required(input, "pubKeyCredParams")).map((item) => {
        const parameter = dictionary(item);
        return {
          type: shortText(required(parameter, "type")),
          alg: number(required(parameter, "alg")) | 0,
        };
      });
      const attestation = input.attestation;
      if (attestation !== undefined) result.attestation = text(attestation);
      const selectionInput = input.authenticatorSelection;
      if (selectionInput !== undefined) {
        const selection = dictionary(selectionInput);
        const converted: Record<string, unknown> = {};
        for (const member of ["authenticatorAttachment", "residentKey", "userVerification"]) {
          const value = selection[member];
          if (value !== undefined) converted[member] = text(value);
        }
        const requireResidentKey = selection.requireResidentKey;
        if (requireResidentKey !== undefined)
          converted.requireResidentKey = Boolean(requireResidentKey);
        result.authenticatorSelection = converted;
      }
    } else {
      if (input.rpId !== undefined) result.rpId = text(input.rpId);
      if (input.userVerification !== undefined)
        result.userVerification = text(input.userVerification);
    }
    return result;
  };
  const parse = (op: "create" | "get", value: unknown): Record<string, unknown> => {
    const output = convert(op, value, true);
    output.challenge = decode(output.challenge, 1024);
    const descriptors = op === "create" ? "excludeCredentials" : "allowCredentials";
    if (Array.isArray(output[descriptors]))
      output[descriptors] = output[descriptors].map((descriptor: Record<string, unknown>) => ({
        ...descriptor,
        id: decode(descriptor.id, 1023),
      }));
    if (op === "create") {
      const user = dictionary(output.user);
      user.id = decode(user.id, 64);
    }
    return output;
  };
  type CredentialJSON = {
    id: string;
    rawId: string;
    type: string;
    authenticatorAttachment?: string;
    clientExtensionResults: Record<string, unknown>;
    response: {
      clientDataJSON: string;
      attestationObject?: string;
      authenticatorData: string;
      publicKey?: string;
      publicKeyAlgorithm?: number;
      transports?: string[];
      signature?: string;
      userHandle?: string;
    };
  };
  const data = new WeakMap<
    object,
    { json: CredentialJSON; buffers: Record<string, ArrayBuffer>; response: object }
  >();
  const read = (receiver: object) => {
    const entry = data.get(receiver);
    if (!entry) throw new TypeError("Illegal invocation");
    return entry;
  };
  const responseBytes = [
    "clientDataJSON",
    "attestationObject",
    "authenticatorData",
    "publicKey",
    "signature",
    "userHandle",
  ] as const;
  const binaryLimits = {
    clientDataJSON: 65_536,
    attestationObject: 16_777_216,
    authenticatorData: 1_048_576,
    publicKey: 65_536,
    signature: 65_536,
    userHandle: 64,
  } as const;
  class AuthenticatorResponse {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
    get clientDataJSON() {
      return read(this).buffers.clientDataJSON;
    }
    get [Symbol.toStringTag]() {
      return "AuthenticatorResponse";
    }
  }
  class AuthenticatorAttestationResponse extends AuthenticatorResponse {
    get attestationObject() {
      return read(this).buffers.attestationObject;
    }
    getAuthenticatorData() {
      return read(this).buffers.authenticatorData;
    }
    getPublicKey() {
      return read(this).buffers.publicKey ?? null;
    }
    getPublicKeyAlgorithm() {
      return read(this).json.response.publicKeyAlgorithm;
    }
    getTransports() {
      return [...(read(this).json.response.transports ?? [])];
    }
    override get [Symbol.toStringTag]() {
      return "AuthenticatorAttestationResponse";
    }
  }
  class AuthenticatorAssertionResponse extends AuthenticatorResponse {
    get authenticatorData() {
      return read(this).buffers.authenticatorData;
    }
    get signature() {
      return read(this).buffers.signature;
    }
    get userHandle() {
      return read(this).buffers.userHandle ?? null;
    }
    override get [Symbol.toStringTag]() {
      return "AuthenticatorAssertionResponse";
    }
  }
  class PublicKeyCredential {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
    get id() {
      return read(this).json.id;
    }
    get type() {
      return "public-key";
    }
    get rawId() {
      return read(this).buffers.rawId;
    }
    get authenticatorAttachment() {
      return read(this).json.authenticatorAttachment ?? null;
    }
    get response() {
      return read(this).response;
    }
    getClientExtensionResults() {
      return clone(read(this).json.clientExtensionResults);
    }
    toJSON() {
      const entry = read(this);
      const json = clone(entry.json);
      json.rawId = encode(new Uint8Array(entry.buffers.rawId!));
      for (const member of responseBytes) {
        const buffer = entry.buffers[member];
        if (buffer !== undefined) json.response[member] = encode(new Uint8Array(buffer));
      }
      return json;
    }
    get [Symbol.toStringTag]() {
      return "PublicKeyCredential";
    }
    static async isUserVerifyingPlatformAuthenticatorAvailable() {
      return true;
    }
    static async isConditionalMediationAvailable() {
      return false;
    }
    static async getClientCapabilities() {
      return Object.fromEntries(
        Object.entries({
          conditionalCreate: false,
          conditionalGet: false,
          "extension:credProps": true,
          hybridTransport: false,
          passkeyPlatformAuthenticator: true,
          relatedOrigins: false,
          signalAllAcceptedCredentials: false,
          signalCurrentUserDetails: false,
          signalUnknownCredential: false,
          userVerifyingPlatformAuthenticator: true,
        }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    static parseCreationOptionsFromJSON(value: unknown) {
      return parse("create", value);
    }
    static parseRequestOptionsFromJSON(value: unknown) {
      return parse("get", value);
    }
  }
  Object.setPrototypeOf(PublicKeyCredential.prototype, Credential.prototype);
  const hydrate = (json: CredentialJSON): object => {
    const created = json.response.attestationObject !== undefined;
    const response = Object.create(
      created
        ? AuthenticatorAttestationResponse.prototype
        : AuthenticatorAssertionResponse.prototype,
    ) as object;
    const credential = Object.create(PublicKeyCredential.prototype) as object;
    const buffers: Record<string, ArrayBuffer> = { rawId: decode(json.rawId, 1023) };
    for (const member of responseBytes) {
      const value = json.response[member];
      if (value !== undefined) buffers[member] = decode(value, binaryLimits[member]);
    }
    const entry = { json: clone(json), buffers, response };
    data.set(response, entry);
    data.set(credential, entry);
    return credential;
  };
  for (const [name, value] of Object.entries({
    PublicKeyCredential,
    AuthenticatorResponse,
    AuthenticatorAttestationResponse,
    AuthenticatorAssertionResponse,
  }))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  // Independent of the binding name, so discovering the reply slot cannot reveal
  // the binding. A page cannot replace this callback to redirect CDP delivery.
  Object.defineProperty(globalThis, replyName, {
    value: (value: {
      id: string;
      credential?: CredentialJSON;
      error?: string;
      message?: string;
    }) => {
      const entry = pending.get(value.id);
      if (!entry) return;
      if (value.error)
        entry.reject(
          value.error === "TypeError" ? malformed() : new Exception(value.message, value.error),
        );
      else {
        try {
          entry.resolve(hydrate(value.credential!));
        } catch {
          entry.reject(failure());
        }
      }
    },
  });
  let binding: ((payload: string) => void) | undefined;
  const findBinding = () => {
    const candidate = describe(root, bindingName)?.value as unknown;
    if (typeof candidate === "function") {
      binding ??= candidate as (payload: string) => void;
      delete root[bindingName];
    }
    return binding;
  };
  for (const op of ["create", "get"] as const) {
    const native = prototype[op];
    Object.defineProperty(prototype, op, {
      configurable: true,
      writable: true,
      value: new Proxy(native, {
        apply(target, receiver, argumentList) {
          const input = argumentList[0] as unknown;
          const isDictionary =
            (typeof input === "object" && input !== null) || typeof input === "function";
          if (!isDictionary) return Reflect.apply(target, receiver, argumentList);
          try {
            const options = dictionary(input);
            const requestedPublicKey = options.publicKey;
            if (requestedPublicKey === undefined)
              return Reflect.apply(target, receiver, argumentList);
            if (
              receiver !== credentials ||
              (initialPopup && globalThis.document === initialPopupDocument)
            )
              return Promise.reject(failure());
            const signal = options.signal as AbortSignal | undefined;
            if (signal !== undefined) {
              const aborted = Object.getOwnPropertyDescriptor(
                AbortSignal.prototype,
                "aborted",
              )!.get!.call(signal) as boolean;
              if (aborted) return Promise.reject(signal.reason);
            }
            const privateSignal = signal === undefined ? undefined : dependentSignal([signal]);
            const requestedMediation = options.mediation;
            const mediation =
              requestedMediation === undefined ? "optional" : text(requestedMediation);
            if (!["silent", "optional", "required", "conditional"].includes(mediation))
              throw malformed();
            if (mediation === "conditional")
              return Promise.reject(
                new Exception("Conditional mediation is not supported.", "NotSupportedError"),
              );
            // Every ceremony here can show the OS passkey sheet, which silent forbids.
            if (mediation === "silent") return Promise.reject(failure());
            // All getters, coercions and byte copies finish before yielding to CDP.
            const publicKey = convert(op, requestedPublicKey);
            const id = uuid();
            const started = now();
            return new Promise((resolve, reject) => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              let sent = false;
              const finish = (error: unknown, value?: unknown) => {
                if (!pending.delete(id)) return;
                unschedule(timer);
                privateSignal?.removeEventListener("abort", abort);
                if (error !== undefined) reject(error);
                else resolve(value);
              };
              const abort = () => {
                if (sent) {
                  try {
                    binding?.(stringify({ op: "cancel", id }));
                  } catch {
                    /* The local abort still wins. */
                  }
                }
                // A signal may have an undefined reason; reject that exact value.
                pending.delete(id);
                unschedule(timer);
                privateSignal?.removeEventListener("abort", abort);
                reject(signal?.reason);
              };
              pending.set(id, {
                resolve: (value) => finish(undefined, value),
                reject: (error) => finish(error),
              });
              privateSignal?.addEventListener("abort", abort, { once: true });
              if (privateSignal?.aborted) {
                abort();
                return;
              }
              const send = () => {
                if (!pending.has(id)) return;
                const call = findBinding();
                if (call) {
                  try {
                    sent = true;
                    // A detached CDP session cannot deliver its refusal. Bound
                    // the page promise independently of the bridge's watchdog.
                    timer = schedule(
                      () => {
                        try {
                          binding?.(stringify({ op: "cancel", id }));
                        } catch {
                          /* The local timeout still settles. */
                        }
                        finish(failure());
                      },
                      Math.min(
                        600_000,
                        Math.max(
                          30_000,
                          typeof publicKey.timeout === "number" ? publicKey.timeout : 300_000,
                        ),
                      ),
                    );
                    call(stringify({ op, id, options: publicKey }));
                  } catch {
                    finish(failure());
                  }
                } else if (now() - started >= 3_000) finish(failure());
                else timer = schedule(send, 10);
              };
              send();
            });
          } catch (error) {
            return Promise.reject(error instanceof TypeError ? malformed() : error);
          }
        },
      }),
    });
  }
}

export function browserPagePolicyScriptFor(config?: BrowserPagePolicyConfig): string {
  return `(${installBrowserPagePolicy.toString()})(${JSON.stringify(config)});`;
}
export const browserPagePolicyScript = browserPagePolicyScriptFor();
