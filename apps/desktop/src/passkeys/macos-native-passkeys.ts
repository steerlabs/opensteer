import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  decodePasskeyRegistration,
  type PasskeyAuthenticatorOutcome,
} from "@opensteer/browser-runtime-core/passkeys";
import type { NativePasskeyRequest, NativePasskeys } from "./native-passkeys.js";

const bytes = (maximum: number, empty = false) =>
  z
    .string()
    .max(Math.ceil(maximum / 3) * 4)
    .transform((value, ctx) => {
      const decoded = Buffer.from(value, "base64");
      if (
        decoded.length > maximum ||
        (!empty && !decoded.length) ||
        decoded.toString("base64") !== value
      ) {
        ctx.addIssue({ code: "custom", message: "Invalid native base64 bytes" });
        return z.NEVER;
      }
      return decoded;
    });
const transport = z.enum(["usb", "nfc", "ble", "smart-card", "hybrid", "internal"]);
const encodedBytes = (maximum: number) =>
  z
    .string()
    .min(4)
    .max(Math.ceil(maximum / 3) * 4)
    .refine((value) => {
      const decoded = Buffer.from(value, "base64");
      return (
        decoded.length > 0 && decoded.length <= maximum && decoded.toString("base64") === value
      );
    });
const requestSchema = z.object({
  operationId: z.string().min(1).max(256),
  op: z.enum(["create", "get"]),
  rpId: z.string().min(1).max(253),
  origin: z.string().min(1).max(2048),
  deadline: z.number().safe().positive(),
  windowNumber: z.number().int().positive(),
  challenge: encodedBytes(1024),
  providers: z.array(z.enum(["platform", "security-key"])).max(2),
  userVerification: z.enum(["required", "preferred", "discouraged"]),
  residentKey: z.enum(["required", "preferred", "discouraged"]),
  attestation: z.literal("none"),
  shouldShowHybridTransport: z.boolean(),
  algorithms: z.array(z.number().int().min(-2147483648).max(2147483647)).max(64),
  credentials: z
    .array(z.object({ id: encodedBytes(1023), transports: z.array(transport).max(16) }))
    .max(64),
  user: z
    .object({ id: encodedBytes(64), name: z.string().max(1024), displayName: z.string().max(1024) })
    .optional(),
});
const resultBase = {
  credentialID: bytes(1023),
  rawClientDataJSON: bytes(16_384),
  provider: z.enum(["platform", "security-key"]),
  attachment: z.enum(["platform", "cross-platform"]).nullable(),
};
const resultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("created"),
    ...resultBase,
    rawAttestationObject: bytes(1_048_576),
    transports: z.array(transport).max(16).nullable(),
  }),
  z.object({
    kind: z.literal("asserted"),
    ...resultBase,
    rawAuthenticatorData: bytes(1_048_576),
    signature: bytes(16_384),
    userID: bytes(64, true).nullable(),
  }),
  z.object({ kind: z.literal("error"), domain: z.string().max(256), code: z.number().safe() }),
]);
const clientDataSchema = z.object({
  type: z.string(),
  challenge: z.string(),
  origin: z.string(),
  crossOrigin: z.boolean().optional(),
});
type Addon = {
  available(): unknown;
  capabilities(): unknown;
  windowNumber(handle: Buffer): unknown;
  start(request: string, callback: (reply: unknown) => void): void;
  cancel(operationId: string): void;
};
const callable = <T>(value: unknown): value is T => typeof value === "function";
const addonSchema = z.object({
  available: z.custom<Addon["available"]>(callable),
  capabilities: z.custom<Addon["capabilities"]>(callable),
  windowNumber: z.custom<Addon["windowNumber"]>(callable),
  start: z.custom<Addon["start"]>(callable),
  cancel: z.custom<Addon["cancel"]>(callable),
});
const refused = (
  error: "NotAllowedError" | "NotSupportedError" | "AbortError" = "NotAllowedError",
): PasskeyAuthenticatorOutcome => ({ kind: "refused", error });

/** Policy lives here; the native shim only applies this validated AS request plan. */
export function buildMacosPasskeyRequest(
  request: NativePasskeyRequest,
  windowNumber: number,
  securityKeys: boolean,
) {
  const create = request.op === "create" ? request.options : undefined;
  const get = request.op === "get" ? request.options : undefined;
  const attachment = create?.authenticatorSelection.authenticatorAttachment;
  const algorithms =
    create?.pubKeyCredParams.filter((p) => p.type === "public-key").map((p) => p.alg) ?? [];
  const descriptors = create?.excludeCredentials ?? get?.allowCredentials ?? [];
  const credentials = descriptors
    .filter((d) => d.type === "public-key")
    .map((d) => ({ id: Buffer.from(d.id).toString("base64"), transports: d.transports ?? [] }));
  // Hints override transport and attachment defaults; the first recognized hint wins.
  const hint = request.options.hints?.find((value) =>
    ["hybrid", "client-device", "security-key"].includes(value),
  );
  // Exclusions do not restrict the choice of transport for a new credential.
  const shouldShowHybridTransport =
    hint !== undefined
      ? hint === "hybrid"
      : attachment !== "platform" &&
        (!get ||
          !descriptors.length ||
          descriptors.some(
            (d) =>
              d.type === "public-key" && (!d.transports?.length || d.transports.includes("hybrid")),
          ));
  const providers: ("platform" | "security-key")[] = [];
  if (!get || !descriptors.length || credentials.length) {
    // Nearby phones are offered only through the platform request, which can
    // also save a local passkey; a cross-platform registration uses it only
    // when the RP asks for a phone, and its result must still be roaming.
    if (
      (attachment !== "cross-platform" || hint === "hybrid") &&
      (!create || algorithms.includes(-7))
    )
      providers.push("platform");
    if (attachment !== "platform" && securityKeys && (!create || algorithms.length))
      providers.push("security-key");
  }
  return requestSchema.parse({
    operationId: request.operationId,
    op: request.op,
    rpId: request.rpId,
    origin: request.origin,
    deadline: request.deadline,
    windowNumber,
    challenge: Buffer.from(request.options.challenge).toString("base64"),
    providers,
    credentials,
    algorithms,
    userVerification: create?.authenticatorSelection.userVerification ?? get?.userVerification,
    residentKey: create?.authenticatorSelection.residentKey ?? "discouraged",
    attestation: "none",
    shouldShowHybridTransport,
    ...(create
      ? {
          user: {
            id: Buffer.from(create.user.id).toString("base64"),
            name: create.user.name,
            displayName: create.user.displayName,
          },
        }
      : {}),
  });
}

export function mapMacosPasskeyError(
  op: "create" | "get",
  domain: string,
  code: number,
): PasskeyAuthenticatorOutcome {
  const excluded =
    op === "create" &&
    ((domain === "com.apple.AuthenticationServices.AuthorizationError" && code === 1006) ||
      (domain === "WKErrorDomain" && code === 8));
  return { kind: "refused", error: excluded ? "InvalidStateError" : "NotAllowedError" };
}

export function mapMacosPasskeyResult(
  request: NativePasskeyRequest,
  value: unknown,
): PasskeyAuthenticatorOutcome {
  const result = resultSchema.parse(value);
  if (result.kind === "error") return mapMacosPasskeyError(request.op, result.domain, result.code);
  if ((request.op === "create") !== (result.kind === "created"))
    throw new TypeError("Native operation mismatch");
  const client = clientDataSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.rawClientDataJSON)),
  );
  if (
    client.type !== `webauthn.${request.op}` ||
    client.challenge !== Buffer.from(request.options.challenge).toString("base64url") ||
    client.origin !== request.origin ||
    client.crossOrigin === true
  )
    throw new TypeError("Native client data mismatch");
  const common = {
    credentialId: result.credentialID,
    clientDataJSON: result.rawClientDataJSON,
    authenticatorAttachment: result.attachment,
  };
  if (result.kind === "created") {
    const decoded = decodePasskeyRegistration(result.rawAttestationObject, result.credentialID);
    if (
      request.op !== "create" ||
      !request.options.pubKeyCredParams.some(
        (p) => p.type === "public-key" && p.alg === decoded.publicKeyAlgorithm,
      )
    )
      throw new TypeError("Unrequested native algorithm");
    if (
      request.options.authenticatorSelection.authenticatorAttachment === "cross-platform" &&
      result.provider === "platform" &&
      result.attachment !== "cross-platform"
    )
      throw new TypeError("Unrequested native attachment");
    return {
      kind: "created",
      ...common,
      ...decoded,
      attestationObject: result.rawAttestationObject,
      transports:
        result.transports ?? (result.provider === "platform" ? ["internal", "hybrid"] : []),
      discoverable:
        result.provider === "platform" ||
        request.options.authenticatorSelection.residentKey === "required"
          ? true
          : null,
    };
  }
  if (result.rawAuthenticatorData.length < 37) throw new TypeError("Truncated authenticator data");
  return {
    kind: "asserted",
    ...common,
    authenticatorData: result.rawAuthenticatorData,
    signature: result.signature,
    userHandle: result.userID?.length ? result.userID : null,
  };
}

function loadAddon(): unknown {
  const filename = path
    .resolve(path.dirname(fileURLToPath(import.meta.url)), "passkeys/opensteer-passkeys.node")
    .replace(/app\.asar\//u, "app.asar.unpacked/");
  if (!existsSync(filename)) return undefined;
  return createRequire(import.meta.url)(filename);
}

export function createMacosNativePasskeys(
  dependencies: {
    platform?: NodeJS.Platform;
    load?: () => unknown;
    addonExists?: () => boolean;
    log?: (domain: string, code: number) => void;
  } = {},
): NativePasskeys {
  let addon: Addon | undefined;
  if ((dependencies.platform ?? process.platform) === "darwin") {
    try {
      if (dependencies.addonExists?.() !== false)
        addon = addonSchema.parse((dependencies.load ?? loadAddon)());
    } catch {
      /* Missing or incompatible native code is unavailable. */
    }
  }
  const available = () => {
    try {
      return addon !== undefined && z.boolean().parse(addon.available());
    } catch {
      return false;
    }
  };
  const active = new Set<string>();
  return {
    available,
    async perform(request, signal) {
      const native = addon;
      if (signal.aborted) return refused("AbortError");
      if (
        !native ||
        !available() ||
        request.window.isDestroyed() ||
        request.deadline <= Date.now() ||
        active.has(request.operationId)
      )
        return refused();
      try {
        const handle = z
          .instanceof(Buffer)
          .refine((v) => v.length === 8)
          .parse(request.window.getNativeWindowHandle());
        const number = z.number().int().positive().parse(native.windowNumber(handle));
        const capabilities = z.object({ securityKeys: z.boolean() }).parse(native.capabilities());
        const plan = buildMacosPasskeyRequest(request, number, capabilities.securityKeys);
        if (!plan.providers.length) return refused("NotSupportedError");
        return await new Promise<PasskeyAuthenticatorOutcome>((resolve) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (outcome: PasskeyAuthenticatorOutcome, cancel = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            request.window.removeListener("closed", closed);
            active.delete(request.operationId);
            resolve(outcome);
            if (cancel) {
              try {
                native.cancel(request.operationId);
              } catch {
                /* Locally settled already. */
              }
            }
          };
          const abort = () => finish(refused("AbortError"), true);
          const closed = () => finish(refused(), true);
          const watchdog = () => {
            const remaining = request.deadline - Date.now();
            if (remaining <= 0) closed();
            else timer = setTimeout(watchdog, Math.min(remaining, 2_147_483_647));
          };
          active.add(request.operationId);
          signal.addEventListener("abort", abort, { once: true });
          request.window.once("closed", closed);
          watchdog();
          if (signal.aborted) {
            abort();
            return;
          }
          if (settled || request.window.isDestroyed()) {
            closed();
            return;
          }
          try {
            native.start(JSON.stringify(plan), (reply) => {
              if (settled) return;
              if (
                request.deadline <= Date.now() ||
                request.window.isDestroyed() ||
                signal.aborted
              ) {
                closed();
                return;
              }
              try {
                const json = z.string().max(3_000_000).parse(reply);
                const value = resultSchema.parse(JSON.parse(json));
                if (value.kind === "error") {
                  (
                    dependencies.log ??
                    ((domain, code) => console.warn("Passkey authorization", domain, code))
                  )(value.domain, value.code);
                  finish(mapMacosPasskeyError(request.op, value.domain, value.code));
                } else finish(mapMacosPasskeyResult(request, JSON.parse(json)));
              } catch {
                finish(refused(), true);
              }
            });
          } catch {
            finish(refused(), true);
          }
        });
      } catch {
        return refused();
      }
    },
  };
}
