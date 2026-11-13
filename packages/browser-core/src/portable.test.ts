import { build } from "esbuild";
import { builtinModules } from "node:module";
import { verify, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserBinaryFrameHeaderSchema,
} from "@opensteer/protocol/browser";
import {
  BrowserRelayFrameHeaderSchema,
  encodeBrowserRelayFrameBytes,
  decodeBrowserRelayFrameBytes,
} from "@opensteer/protocol/browser-relay";
import {
  verifyAttachTicket,
  transitionReplayLedger,
  type ReplayLedgerState,
} from "./attach-ticket-policy.js";
import { encodeFrameEnvelope, decodeFrameEnvelope } from "./bytes.js";
import tickets from "../test-vectors/attach-tickets.v1.json" with { type: "json" };
import frames from "../test-vectors/frames.v1.json" with { type: "json" };
import fences from "../test-vectors/fences.v1.json" with { type: "json" };

it("runs the portable entry points without Node globals or reachable built-ins", async () => {
  const forbidden = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const entries = [
    "bytes",
    "attach-ticket-policy",
    "portable-session-cdp-router",
    "agent-cdp-policy",
    "agent-cdp-allowlist",
    "execution-contexts",
    "key-codes",
    "input-lane",
    "page-policy",
    "latest-frame-stream",
  ];
  const result = await build({
    stdin: {
      contents:
        entries.map((name) => `export * from "./${name}.js";`).join("\n") +
        '\nexport * from "../../runner-client/src/auxiliary-fence.js";\nexport * from "../../protocol/src/browser-relay.js";',
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "portable",
    metafile: true,
    plugins: [
      {
        name: "no-node",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (forbidden.has(args.path))
              throw new Error(`Node built-in reached portable browser code: ${args.path}`);
            return undefined;
          });
        },
      },
    ],
  });
  const code = result.outputFiles[0]!.text;
  const sandbox = { TextEncoder, TextDecoder, URL, console, performance };
  const api = runInNewContext(`${code}; portable`, sandbox) as {
    utf8Size(value: string): number;
    encodeFrameEnvelope(header: unknown, payload: Uint8Array): Uint8Array;
    decodeFrameEnvelope(bytes: Uint8Array): { header: unknown; payload: Uint8Array };
    decodeBrowserRelayFrameBytes(bytes: Uint8Array): { header: unknown; frame: Uint8Array };
  };
  expect(api.utf8Size("A😀字")).toBe(8);
  expect(
    api.decodeFrameEnvelope(api.encodeFrameEnvelope({ ok: true }, new Uint8Array([1]))).header,
  ).toEqual({ ok: true });
  expect(
    api.decodeBrowserRelayFrameBytes(Uint8Array.from(Buffer.from(frames.relayEnvelopeHex, "hex")))
      .header,
  ).toEqual(frames.relayHeader);
  expect(Object.keys(result.metafile?.inputs ?? {})).not.toHaveLength(0);
});

it("shares exact single and double-envelope bytes with native encoders, including offset views", () => {
  const payload = new Uint8Array(Buffer.from(frames.payloadHex, "hex"));
  const header = BrowserBinaryFrameHeaderSchema.parse(frames.header);
  const encoded = encodeFrameEnvelope(header, payload);
  expect(Buffer.from(encoded).toString("hex")).toBe(frames.envelopeHex);
  const padded = new Uint8Array(encoded.byteLength + 5);
  padded.set(encoded, 3);
  expect(decodeFrameEnvelope(padded.subarray(3, -2))).toEqual({ header, payload });
  const relayHeader = BrowserRelayFrameHeaderSchema.parse(frames.relayHeader);
  expect(Buffer.from(encodeBrowserRelayFrameBytes(relayHeader, encoded)).toString("hex")).toBe(
    frames.relayEnvelopeHex,
  );
  expect(
    decodeBrowserRelayFrameBytes(new Uint8Array(Buffer.from(frames.relayEnvelopeHex, "hex"))),
  ).toEqual({ header: relayHeader, frame: encoded });
  for (const hex of frames.invalidHex)
    expect(() => decodeFrameEnvelope(new Uint8Array(Buffer.from(hex, "hex")))).toThrow();
});

it("shares signed malicious-ticket vectors and commits replay admission before returning claims", async () => {
  const publicKey = createPublicKey(tickets.publicKeyPem);
  for (const vector of tickets.cases) {
    let committed = false;
    const promise = verifyAttachTicket(
      vector.token,
      { runtimeId: tickets.runtimeId, now: tickets.now },
      {
        decodeBase64Url,
        parseClaims: (value) => BrowserAttachTicketClaimsSchema.parse(value),
        verify: async (keyId, signed, signature) =>
          keyId === "fixture" && verify(null, signed, publicKey, signature),
        claim: async () => {
          committed = true;
        },
      },
    );
    if (vector.accepted)
      expect(await promise, vector.name).toEqual(
        "claims" in vector ? vector.claims : tickets.claims,
      );
    else await expect(promise, vector.name).rejects.toThrow(vector.error);
    expect(committed, vector.name).toBe(vector.accepted);
  }
  await expect(
    verifyAttachTicket(
      tickets.cases[0]!.token,
      { runtimeId: tickets.runtimeId, now: tickets.now },
      {
        decodeBase64Url,
        parseClaims: (value) => BrowserAttachTicketClaimsSchema.parse(value),
        verify: async (_keyId, signed, signature) => verify(null, signed, publicKey, signature),
        claim: async () => {
          throw new Error("durable write failed");
        },
      },
    ),
  ).rejects.toThrow("durable write failed");
});

it("shares replay transitions with native peers", () => {
  let state = fences.replay.initial as ReplayLedgerState;
  for (const vector of fences.replay.cases) {
    const transition = () =>
      transitionReplayLedger(
        state,
        vector.nonce,
        vector.expiresAt ?? fences.replay.expiresAt,
        vector.now,
        2,
      );
    if (vector.accepted) state = transition();
    else expect(transition).toThrow(expect.objectContaining({ code: vector.error }));
  }
});

const writeVectors = process.env.OPENSTEER_WRITE_PHONE_VECTORS === "1";

it("derives the shared ticket vectors, with every claim a phone browser can receive", () => {
  const { vectors: generated, everyPhoneClaim: every } = attachTicketVectors();
  if (writeVectors)
    writeFileSync(
      new URL("../test-vectors/attach-tickets.v1.json", import.meta.url),
      `${JSON.stringify(generated, null, 2)}\n`,
    );
  else expect(tickets, "Regenerate with OPENSTEER_WRITE_PHONE_VECTORS=1").toEqual(generated);
  expect(BrowserAttachTicketClaimsSchema.parse(every)).toEqual(every);
  // Person autofill is issued only to a runtime advertising it, and phones never do.
  expect(Object.keys(every).sort()).toEqual(
    Object.keys(BrowserAttachTicketClaimsSchema.shape)
      .filter((claim) => claim !== "personFillVersion")
      .sort(),
  );
});

/** Swift and Kotlin admit these exact bytes, so a claim renamed here fails on every phone. */
function attachTicketVectors() {
  // Disposable fixture keys; only the public half is published.
  const fixtureKey = ed25519Key(0x5e);
  const otherKey = ed25519Key(0x5f);
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const claims = {
    access: "read-write",
    audience: "opensteer-browser-runtime",
    wireVersion: 2,
    operationExpiresAt: at(18_000),
    remainingBudgetMs: 18_000,
    expiresAt: at(60_000),
    identity: { kind: "fresh" },
    issuedAt: at(0),
    nonce: "fixture-ticket-nonce-0001",
    runtimeId: "phone",
    sessionId: "bsn_11111111-1111-4111-8111-111111111111",
    subject: "fixture-owner",
    creationOrigin: "person",
  };
  const everyPhoneClaim = {
    ...claims,
    creationOrigin: "agent",
    nonce: "fixture-ticket-nonce-0002",
    passkeys: 1,
    navigationVersion: 1,
    initialNavigation: {
      operationKey: "open",
      url: "https://example.test/",
      navigationId: "22222222-2222-4222-8222-222222222222",
    },
    navigationAttributionVersion: 1,
    editingVersion: 2,
    clipboard: true,
    basicInput: 1,
    surfaceState: 1,
    tabRestoreVersion: 1,
    popupFollowVersion: 1,
    initialSurfaceId: "bsf_33333333-3333-4333-8333-333333333333",
    viewport: { width: 390, height: 844 },
  };
  const header = { alg: "EdDSA", kid: "fixture", typ: "opensteer-browser-attach+jwt" };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (body: object, head: object = header, key: KeyObject = fixtureKey) => {
    const signed = `${encode(head)}.${encode(body)}`;
    return `${signed}.${sign(null, Buffer.from(signed), key).toString("base64url")}`;
  };
  const valid = token(claims);
  const [validHeader, validPayload, validSignature] = valid.split(".") as [string, string, string];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  // The last of 86 characters carries four zero padding bits; setting one keeps the bytes but not the encoding.
  const noncanonical =
    validSignature.slice(0, -1) + alphabet[alphabet.indexOf(validSignature.at(-1)!) + 1];
  const { creationOrigin: _omitted, ...withoutOrigin } = claims;
  const refused = (name: string, error: string, value: string) => ({
    name,
    accepted: false,
    token: value,
    error,
  });
  const headerError = "The browser attach ticket header is invalid.";
  const claimsError = "The browser attach ticket claims is invalid.";
  const signatureError = "The browser attach ticket signature is invalid.";
  const malformed = "The browser attach ticket is malformed.";
  const vectors = {
    version: 1,
    now,
    runtimeId: "phone",
    publicKeyPem: createPublicKey(fixtureKey).export({ type: "spki", format: "pem" }).toString(),
    claims,
    cases: [
      { name: "valid", accepted: true, token: valid },
      {
        name: "every-phone-claim",
        accepted: true,
        token: token(everyPhoneClaim),
        claims: everyPhoneClaim,
      },
      refused("algorithm-confusion", headerError, token(claims, { ...header, alg: "HS256" })),
      refused(
        "unknown-header",
        headerError,
        token(claims, { ...header, jku: "https://hostile.test" }),
      ),
      refused(
        "wrong-runtime",
        "The browser attach ticket targets another runtime.",
        token({ ...claims, runtimeId: "other" }),
      ),
      refused(
        "expired",
        "The browser attach ticket has expired.",
        token({ ...claims, issuedAt: at(-60_000), expiresAt: at(0) }),
      ),
      refused(
        "not-active",
        "The browser attach ticket is not active yet.",
        token({ ...claims, issuedAt: at(6_000), expiresAt: at(66_000) }),
      ),
      refused(
        "excess-lifetime",
        "The browser attach ticket lifetime is invalid.",
        token({ ...claims, expiresAt: at(300_001) }),
      ),
      refused(
        "tampered-payload",
        signatureError,
        `${validHeader}.${encode({ ...claims, subject: "attacker" })}.${validSignature}`,
      ),
      refused("padded-signature", malformed, `${valid}=`),
      refused("short-signature", signatureError, `${validHeader}.${validPayload}.AA`),
      refused("wrong-key", signatureError, token(claims, header, otherKey)),
      refused("malformed-token", malformed, `${validHeader}.${validPayload}`),
      refused(
        "noncanonical-signature",
        malformed,
        `${validHeader}.${validPayload}.${noncanonical}`,
      ),
      refused("wrong-wire-version", claimsError, token({ ...claims, wireVersion: 1 })),
      refused("missing-creation-origin", claimsError, token(withoutOrigin)),
      refused(
        "invalid-creation-origin",
        claimsError,
        token({ ...claims, creationOrigin: "workspace" }),
      ),
    ],
  };
  return { vectors, everyPhoneClaim };
}

function ed25519Key(fill: number): KeyObject {
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    format: "der",
    type: "pkcs8",
    key: Buffer.concat([pkcs8Prefix, Buffer.alloc(32, fill)]),
  });
}
