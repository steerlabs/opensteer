/**
 * Round H: a pool host pulls a slot's upstream credentials from the account service, as a Home's
 * machine pulls its own. Fixed contract (shared with the account-service route):
 *
 *   POST {accountOrigin}/v1/browser-pool/hosts/{hostId}/slot-egress
 *   { "v": 1, "hostId", "slotId", "issuedAt", "nonce", "signature" }
 *
 * `issuedAt` is ISO-8601 UTC with milliseconds, `nonce` 16 random bytes as base64url without
 * padding, `signature` base64 of an Ed25519 signature by the host key over the UTF-8 bytes of
 * `slotEgressBytes`. The answer is `200 {"egress": {url, username, password}}`, or `200 {}` when
 * none is assigned; anything else could not be completed. TLS with the system's roots, no
 * redirect followed, the answer capped at 16 KiB. The password is never logged and never in an
 * error message.
 */
import { randomBytes, sign, type KeyObject } from "node:crypto";
import { request } from "node:https";
import { getCACertificates } from "node:tls";
import {
  browserEgressCredentialWritable,
  parseBrowserEgressUpstreamUrl,
} from "@opensteer/browser-runtime-core/browser-egress-upstream";

export const slotEgressDomain = "opensteer-pool-slot-egress-v1";
const maximumAnswerBytes = 16 * 1024;

export interface SlotEgressAnswer {
  /** `https://host:port`, no user info. */
  readonly upstreamUrl: string;
  readonly username: string;
  readonly password: string;
}

/** The fetch could not be completed: no answer, a refusal, or a malformed answer. */
export class SlotEgressUnavailable extends Error {
  override readonly name = "SlotEgressUnavailable";
}

export function slotEgressBytes(
  hostId: string,
  slotId: string,
  issuedAt: string,
  nonce: string,
): Buffer {
  return Buffer.from([slotEgressDomain, hostId, slotId, issuedAt, nonce].join("\n"), "utf8");
}

export async function fetchSlotEgress(options: {
  readonly origin: string;
  readonly hostId: string;
  readonly hostKey: KeyObject;
  readonly slotId: string;
  readonly signal: AbortSignal;
  /** The roots the origin is checked against; the system's by default. */
  readonly ca?: readonly string[];
  readonly now?: () => number;
}): Promise<SlotEgressAnswer | null> {
  const issuedAt = new Date((options.now ?? Date.now)()).toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const signature = sign(
    null,
    slotEgressBytes(options.hostId, options.slotId, issuedAt, nonce),
    options.hostKey,
  ).toString("base64");
  const body = JSON.stringify({
    v: 1,
    hostId: options.hostId,
    slotId: options.slotId,
    issuedAt,
    nonce,
    signature,
  });
  const url = new URL(
    `/v1/browser-pool/hosts/${encodeURIComponent(options.hostId)}/slot-egress`,
    options.origin,
  );
  if (url.protocol !== "https:")
    throw new SlotEgressUnavailable("The account origin is not https.");
  const { status, text } = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          ca: [...(options.ca ?? getCACertificates("system"))],
          signal: options.signal,
        },
        (response) => {
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumAnswerBytes) {
              response.destroy();
              reject(new SlotEgressUnavailable("The account service's answer is too large."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", () =>
            reject(new SlotEgressUnavailable("The account service's answer was cut off.")),
          );
          // Round I, U8: a response that closes before it is complete fails at once.
          response.on("close", () => {
            if (!response.complete)
              reject(new SlotEgressUnavailable("The account service's answer was cut off."));
          });
        },
      );
      outgoing.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          new SlotEgressUnavailable(
            `The account service could not be reached (${error.code ?? error.name}).`,
          ),
        ),
      );
      outgoing.end(body);
    },
  );
  // No redirect is followed: anything but 200 is a refusal.
  if (status !== 200) throw new SlotEgressUnavailable(`The account service answered ${status}.`);
  return parseAnswer(text);
}

function parseAnswer(text: string): SlotEgressAnswer | null {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new SlotEgressUnavailable("The account service's answer is not JSON.");
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer))
    throw new SlotEgressUnavailable("The account service's answer is not an object.");
  const keys = Object.keys(answer);
  if (keys.length === 0) return null;
  if (keys.length !== 1 || keys[0] !== "egress")
    throw new SlotEgressUnavailable("The account service's answer has unexpected fields.");
  const egress = (answer as { egress: unknown }).egress;
  if (!egress || typeof egress !== "object")
    throw new SlotEgressUnavailable("The account service's egress is malformed.");
  const { url, username, password } = egress as Record<string, unknown>;
  if (typeof url !== "string" || typeof username !== "string" || typeof password !== "string")
    throw new SlotEgressUnavailable("The account service's egress is malformed.");
  return acceptSlotEgress({ upstreamUrl: url, username, password });
}

/**
 * Round I, U2: an upstream a pool host may write for a slot's proxy, checked by the same
 * function the proxy's own configuration uses (`browser-egress-upstream.ts`), so nothing is
 * written that the proxy would refuse to start with. The address is kept as the proxy reads it.
 */
export function acceptSlotEgress(egress: SlotEgressAnswer): SlotEgressAnswer {
  const url = parseBrowserEgressUpstreamUrl(egress.upstreamUrl);
  if (!url) throw new SlotEgressUnavailable("The egress address is not an https proxy address.");
  if (!browserEgressCredentialWritable(egress.username, "username"))
    throw new SlotEgressUnavailable("The egress username is malformed.");
  if (!browserEgressCredentialWritable(egress.password, "password"))
    throw new SlotEgressUnavailable("The egress password is malformed.");
  return { upstreamUrl: url.text, username: egress.username, password: egress.password };
}
