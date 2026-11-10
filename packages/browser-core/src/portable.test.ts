import { build } from "esbuild";
import { builtinModules } from "node:module";
import { verify, createPublicKey } from "node:crypto";
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
    if (vector.accepted) expect(await promise, vector.name).toEqual(tickets.claims);
    else await expect(promise, vector.name).rejects.toThrow();
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
