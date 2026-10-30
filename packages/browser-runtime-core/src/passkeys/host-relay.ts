import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decodeBase64Url, encodeBase64Url } from "@opensteer/shared/base64url";
import {
  PasskeyCeremonySchema,
  PasskeyOutcomeSchema,
  passkeyBytesToJSON,
  type PasskeyCause,
} from "@opensteer/protocol/passkeys";
import type { BrowserServerMessage, BrowserClientMessage } from "@opensteer/protocol/browser";
import type {
  PasskeyAuthenticator,
  PasskeyAuthenticatorInput,
  PasskeyAuthenticatorOutcome,
} from "./authenticator.js";
const refused = { kind: "refused", error: "NotAllowedError" } as const;
/** Decode bounded wire values once, retaining every authenticator byte. */
export function passkeyOutcomeFromJSON(value: unknown): PasskeyAuthenticatorOutcome {
  const outcome = PasskeyOutcomeSchema.parse(value);
  if (outcome.kind === "refused") return outcome;
  const common = {
    ...outcome,
    credentialId: decodeBase64Url(outcome.credentialId),
    clientDataJSON: decodeBase64Url(outcome.clientDataJSON),
    authenticatorData: decodeBase64Url(outcome.authenticatorData),
  };
  return outcome.kind === "created"
    ? {
        ...common,
        kind: "created",
        attestationObject: decodeBase64Url(outcome.attestationObject),
        publicKey: outcome.publicKey === null ? null : decodeBase64Url(outcome.publicKey),
        publicKeyAlgorithm: outcome.publicKeyAlgorithm,
        transports: outcome.transports,
        discoverable: outcome.discoverable,
      }
    : {
        ...common,
        kind: "asserted",
        signature: decodeBase64Url(outcome.signature),
        userHandle: outcome.userHandle === null ? null : decodeBase64Url(outcome.userHandle),
      };
}
export function passkeyClientDataMatches(
  input: Pick<PasskeyAuthenticatorInput, "origin" | "op" | "options">,
  outcome: PasskeyAuthenticatorOutcome,
): boolean {
  if (outcome.kind === "refused") return true;
  try {
    const data = z
      .object({
        type: z.string(),
        challenge: z.string(),
        origin: z.string(),
        crossOrigin: z.literal(false).optional(),
      })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outcome.clientDataJSON)));
    return (
      data.type === `webauthn.${input.op}` &&
      data.challenge === encodeBase64Url(input.options.challenge) &&
      data.origin === input.origin &&
      (input.op === "create" ? outcome.kind === "created" : outcome.kind === "asserted")
    );
  } catch {
    return false;
  }
}
interface Route {
  readonly sessionId: string;
  readonly surfaceId: string;
  send(message: BrowserServerMessage): void;
}
/** One physical browser's relay; each request remains pinned to its session and document. */
export class HostRelayAuthenticator implements PasskeyAuthenticator {
  readonly #route: (targetId: string) => Route | undefined;
  readonly #inputs = new Map<string, Map<string, number>>();
  readonly #pending = new Map<
    string,
    { sessionId: string; settle(outcome: PasskeyAuthenticatorOutcome): void }
  >();
  constructor(route: (targetId: string) => Route | undefined) {
    this.#route = route;
  }
  record(targetId: string, cause: PasskeyCause): void {
    for (const [target, inputs] of this.#inputs) {
      for (const [key, at] of inputs) if (Date.now() - at >= 5000) inputs.delete(key);
      if (!inputs.size) this.#inputs.delete(target);
    }
    const entries = this.#inputs.get(targetId) ?? new Map<string, number>();
    for (const [key, at] of entries) if (Date.now() - at >= 5000) entries.delete(key);
    entries.set(typeof cause === "object" ? cause.person : cause, Date.now());
    this.#inputs.set(targetId, entries);
  }
  cause(targetId: string): PasskeyCause {
    const entries = this.#inputs.get(targetId);
    if (!entries) return "unknown";
    const recent = [...entries].filter(([, at]) => Date.now() - at < 5000).map(([key]) => key);
    if (recent.includes("agent")) return "agent";
    return recent.length === 1 && recent[0] !== "unknown" ? { person: recent[0]! } : "unknown";
  }
  forget(targetId: string): void {
    this.#inputs.delete(targetId);
  }
  ceremony(input: PasskeyAuthenticatorInput): Promise<PasskeyAuthenticatorOutcome> {
    const route = input.targetId ? this.#route(input.targetId) : undefined;
    if (
      !route ||
      !input.documentId ||
      !input.deadline ||
      !input.clientDataJSON ||
      input.signal.aborted ||
      input.deadline <= Date.now()
    )
      return Promise.resolve(refused);
    const ceremonyId = randomUUID();
    const message = PasskeyCeremonySchema.parse({
      ...passkeyBytesToJSON({
        op: input.op,
        options: input.options,
        clientDataJSON: input.clientDataJSON,
      }),
      type: "passkey.ceremony",
      ceremonyId,
      surfaceId: route.surfaceId,
      documentId: input.documentId,
      origin: input.origin,
      rpId: input.rpId,
      cause: this.cause(input.targetId!),
      deadline: input.deadline,
    });
    return new Promise((resolve) => {
      const cancel = () => {
        try {
          route.send({ type: "passkey.cancel", ceremonyId });
        } finally {
          settle(refused);
        }
      };
      const timer = setTimeout(cancel, Math.max(0, input.deadline! - Date.now()));
      timer.unref();
      const settle = (outcome: PasskeyAuthenticatorOutcome) => {
        if (!this.#pending.delete(ceremonyId)) return;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", cancel);
        resolve(
          Date.now() < input.deadline! &&
            !input.signal.aborted &&
            passkeyClientDataMatches(input, outcome)
            ? outcome
            : refused,
        );
      };
      this.#pending.set(ceremonyId, { sessionId: route.sessionId, settle });
      input.signal.addEventListener("abort", cancel, { once: true });
      try {
        route.send(message);
      } catch {
        settle(refused);
      }
    });
  }
  result(
    sessionId: string,
    message: Extract<BrowserClientMessage, { type: "passkey.result" }>,
  ): void {
    const pending = this.#pending.get(message.ceremonyId);
    if (pending?.sessionId !== sessionId) return;
    try {
      pending.settle(passkeyOutcomeFromJSON(message.outcome));
    } catch {
      pending.settle(refused);
    }
  }
  disconnect(sessionId: string): void {
    for (const pending of this.#pending.values())
      if (pending.sessionId === sessionId) pending.settle(refused);
  }
  close(): void {
    for (const pending of this.#pending.values()) pending.settle(refused);
    this.#inputs.clear();
  }
}
