import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokenDigest } from "@opensteer/core/crypto";
import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import { parseComputerAppConfig } from "@opensteer/integration-core";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import {
  AndroidPhoneDispatchActParamsSchema,
  AndroidPhoneInstalledAppsParamsSchema,
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
  DisplayDataServerMessageSchema,
  DisplayDataTicketClaimsSchema,
  DisplayMediaFrameHeaderSchema,
  DisplayViewerFrameHeaderSchema,
  decodeDisplayMediaFrame,
  decodeDisplayViewerFrame,
  encodeDisplayMediaFrame,
  encodeDisplayViewerFrame,
  displayDataTicketTtlMs,
  displayDefaultMaxLongSide,
  displayDefaultMaxFps,
  HostToRunnerMessageSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryWelcomeSchema,
  androidPhoneDefinitionId,
} from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { describe, expect, it } from "vitest";
import { createRunnerAuxiliarySignature, runnerAuxiliaryTicketDigest } from "./auxiliary.js";
import {
  canonicalRunnerPublicKeyPem,
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
} from "./proof.js";

/**
 * Golden vectors for the Agent Phone app, which re-implements these proofs in
 * Kotlin.
 *
 * Every value here comes from the TypeScript code that the Host verifies with,
 * from fixed keys and a fixed clock, so the phone's tests compare its bytes to
 * the bytes the Host actually expects rather than to a second reading of the
 * same specification. The fixture is checked in; this test fails when the
 * protocol drifts from it, and `OPENSTEER_WRITE_AGENT_PHONE_VECTORS=1`
 * rewrites it after an intended change.
 */
const fixturePath = fileURLToPath(new URL("../fixtures/agent-phone-vectors.json", import.meta.url));

/** An Ed25519 private key from a fixed 32-byte seed, through PKCS#8 as Node imports one. */
function ed25519FromSeed(seed: Uint8Array) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({
    format: "der",
    key: Buffer.concat([prefix, Buffer.from(seed)]),
    type: "pkcs8",
  });
  const raw = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  return { privateKey, publicKeyRaw: raw, seed: Buffer.from(seed).toString("hex") };
}

const runnerKey = ed25519FromSeed(Uint8Array.from({ length: 32 }, (_, index) => index));

/**
 * Raw JSON documents that exercise every escaping, ordering and number rule
 * `canonicalJson` has for what the phone signs. They are kept as text because
 * some of what they test — a negative zero, a lone surrogate — does not
 * survive being written out by `JSON.stringify` again: both implementations
 * parse the same text first. Every number the phone sends or signs is a safe
 * integer, so the numbers here are integers, up to both safe-integer bounds,
 * in each spelling JSON allows one.
 */
const canonicalCases: readonly string[] = [
  String.raw`{"b":1,"a":[0,-0,123456789012,9007199254740991,-9007199254740991],"Z":3,"_":4,"é":2,"😀":5,"ｚ":6}`,
  String.raw`["quote\"backslash\\slash/tab\tnewline\ncr\rbell\u0007unit\u001f","  ","é😀"]`,
  String.raw`{"nested":{"y":null,"x":true,"w":false},"empty":{},"list":[]}`,
  String.raw`"plain"`,
  String.raw`-12`,
  String.raw`-0`,
  String.raw`[1e3,2E2,100,-1,10.0,-0.0]`,
  String.raw`["\ud800","\udfff","x\ud83dy","😀","é","\u0000"]`,
];

const challenge = RunnerChallengeSchema.parse({
  challengeId: "rch_11111111-1111-4111-8111-111111111111",
  expiresAt: "2026-10-11T12:00:15.000Z",
  hostSessionId: "A".repeat(32),
  nonce: "B".repeat(43),
  proofFormatVersion: 2,
  type: "host.challenge",
});

const descriptor = RunnerDescriptorSchema.parse({
  bootId: "rbt_22222222-2222-4222-8222-222222222222",
  capabilities: [],
  device: { form: "phone", platform: "android" },
  modules: {
    integrations: {
      platform: "android",
      protocolVersion: 4,
    },
  },
  name: 'Pixel 9 — Alex\'s "agent" phone',
  runnerId: "rnr_33333333-3333-4333-8333-333333333333",
  runnerKind: "local",
  runtimeVersion: "0.1.117",
});

const enrollmentToken = "enrollment-token-0123456789abcdefghijklmnopqrstuvwxyz";

const auxiliaryChallenge = RunnerAuxiliaryChallengeSchema.parse({
  challengeId: "rch_44444444-4444-4444-8444-444444444444",
  expiresAt: "2026-10-11T12:00:30.000Z",
  hostSessionId: "C".repeat(32),
  module: "integrations",
  nonce: "D".repeat(43),
  type: "host.auxiliary.challenge",
});
const auxiliaryTicket = "eyJhbGciOiJFZERTQSJ9.eyJ4IjoxfQ.c2ln";

const connectionFence = {
  bootId: descriptor.bootId,
  connectionGeneration: 3,
  connectionId: "rcn_11111111-1111-4111-8111-111111111111",
  connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111",
  runnerId: descriptor.runnerId,
};
const streamFence = {
  ...connectionFence,
  auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
  module: "integrations" as const,
};
const displaySessionId = "cus_99999999-9999-4999-8999-999999999999";
const displayStreamId = "dsp_11111111-1111-4111-8111-111111111111";
const displayEvents = [
  { kind: "pointer", phase: "down", x: 0.25, y: 0.75, t: 1000 },
  { kind: "pointer", phase: "move", x: 0.5, y: 0.5, t: 1032.5 },
  { kind: "pointer", phase: "up", x: 0.75, y: 0.25, t: 1064 },
  { kind: "pointer", phase: "cancel", x: 0.75, y: 0.25, t: 1065 },
  { kind: "scroll", x: 0.5, y: 0.5, dx: -0.25, dy: 1 },
  ...["back", "home", "recents", "notifications"].map((to) => ({ kind: "nav", to })),
  { kind: "text", insert: "milk, eggs ✓" },
  { kind: "text", deleteBackward: 2 },
  { kind: "text", submit: true },
];

/**
 * One frame of every kind the Host sends a phone, built here and parsed by
 * the very schemas the Host sends with, so the phone's tests decode exactly
 * what a Host may put on the wire: its strict decoders and these schemas
 * cannot drift apart without one side's test failing. `channel` names the
 * socket and decoder each arrives on.
 */
function hostFrames() {
  const runId = "run_55555555-5555-4555-8555-555555555555";
  const sessionId = "cus_99999999-9999-4999-8999-999999999999";
  const primary = (frame: object) => ({
    channel: "primary",
    frame: HostToRunnerMessageSchema.parse(frame),
  });
  const stream = (frame: object) => ({
    channel: "integrations",
    frame: HostToIntegrationsModuleMessageSchema.parse(frame),
  });
  const computerUse = (operation: string, access: string | null, params: object) =>
    stream({
      ...streamFence,
      access,
      app: null,
      definitionId: androidPhoneDefinitionId,
      operation,
      params,
      requestId: `cu:${operation}`,
      runId,
      sessionId,
      threadTitle: "Groceries ✓",
      timeoutMs: 60_000,
      type: "host.integrations.computer-use",
    });
  const mcpSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return [
    primary(challenge),
    primary({
      ...connectionFence,
      allowedModules: ["integrations"],
      connectionLeaseExpiresAt: "2026-10-11T12:02:00.000Z",
      environmentIds: [],
      heartbeatIntervalMs: 15_000,
      serverTime: "2026-10-11T12:00:00.000Z",
      type: "host.welcome",
    }),
    primary({
      ...connectionFence,
      connectionLeaseExpiresAt: "2026-10-11T12:04:00.000Z",
      type: "host.connection.lease-renewed",
    }),
    primary({
      ...connectionFence,
      expiresAt: "2026-10-11T12:01:00.000Z",
      module: "integrations",
      requestId: "aux:11111111-1111-4111-8111-111111111111",
      ticket: auxiliaryTicket,
      type: "host.auxiliary.ticket",
    }),
    primary({
      error: {
        code: "forbidden",
        message: "Runner enrollment expired",
        reason: "runner-enrollment-expired",
        retryable: false,
      },
      type: "host.error",
    }),
    { channel: "auxiliary", frame: RunnerAuxiliaryChallengeSchema.parse(auxiliaryChallenge) },
    {
      channel: "auxiliary",
      frame: RunnerAuxiliaryWelcomeSchema.parse({
        ...streamFence,
        heartbeatIntervalMs: 15_000,
        serverTime: "2026-10-11T12:00:01.000Z",
        streamLeaseExpiresAt: "2026-10-11T12:02:01.000Z",
        type: "host.auxiliary.welcome",
      }),
    },
    {
      channel: "auxiliary",
      frame: RunnerAuxiliaryRejectedSchema.parse({
        error: { code: "forbidden", message: "That ticket was already used.", retryable: false },
        type: "host.auxiliary.rejected",
      }),
    },
    stream({
      ...streamFence,
      streamLeaseExpiresAt: "2026-10-11T12:04:01.000Z",
      type: "host.auxiliary.lease-renewed",
    }),
    computerUse("observe", "read", { includeScreenshot: true }),
    // Parameters as the Host sends them: parsed, so every default is filled in.
    computerUse(
      "act",
      "read-write",
      AndroidPhoneDispatchActParamsSchema.parse({
        actions: [
          { target: { index: 3 }, type: "tap" },
          { submit: true, text: "milk, eggs ✓", type: "type" },
          { amount: 2, direction: "down", target: { x: 540, y: 1200 }, type: "scroll" },
          { from: { index: 1 }, to: { x: 10, y: 20 }, type: "drag" },
          { packageName: "com.google.android.apps.maps", type: "launch" },
          { to: "home", type: "navigate" },
          { ms: 500, type: "wait" },
        ],
        includeScreenshot: false,
        observationId: "obs_0123456789abcdef0123456789abcdef",
      }),
    ),
    computerUse("close", null, {}),
    computerUse(
      "installed_apps",
      null,
      AndroidPhoneInstalledAppsParamsSchema.parse({ offset: 40, query: "maps" }),
    ),
    stream({ ...streamFence, requestId: "cu:act", type: "host.integrations.cancel" }),
    stream({
      ...streamFence,
      runId,
      sessionId,
      type: "host.integrations.computer-use-stop-recorded",
    }),
    stream({
      ...streamFence,
      launch: { args: [], command: "notes-mcp", cwd: "/tmp", env: {}, type: "stdio" },
      serverId: "isv_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sessionId: mcpSessionId,
      type: "host.integrations.mcp.open",
    }),
    stream({
      ...streamFence,
      message: { id: 1, jsonrpc: "2.0", method: "tools/list" },
      sessionId: mcpSessionId,
      type: "host.integrations.mcp.message",
    }),
    stream({ ...streamFence, sessionId: mcpSessionId, type: "host.integrations.mcp.close" }),
    stream({
      ...streamFence,
      access: "read",
      arguments: { query: "milk" },
      contract: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
      definitionId: "apple-notes",
      operation: "search_notes",
      requestId: "invoke:1",
      timeoutMs: 30_000,
      type: "host.integrations.invoke",
    }),
    stream({
      ...streamFence,
      display: "main",
      streamId: displayStreamId,
      dataTicket: auxiliaryTicket,
      revision: 0,
      sources: [{ kind: "task-session", sessionId }],
      maxLongSide: displayDefaultMaxLongSide,
      maxFps: displayDefaultMaxFps,
      editingVersion: 1,
      sharedInput: 1,
      type: "host.integrations.display.start",
    }),
    stream({
      ...streamFence,
      display: "main",
      streamId: displayStreamId,
      type: "host.integrations.display.stop",
    }),
    stream({
      ...streamFence,
      display: "main",
      streamId: displayStreamId,
      type: "host.integrations.display.refresh",
    }),
    stream({
      ...streamFence,
      sessionId,
      streamId: displayStreamId,
      geometry: 1,
      sequence: 0,
      events: displayEvents,
      type: "host.integrations.display.input",
    }),
    stream({
      ...streamFence,
      sessionId,
      streamId: displayStreamId,
      type: "host.integrations.display.input-reset",
    }),
    stream({
      ...streamFence,
      display: "main",
      streamId: displayStreamId,
      revision: 1,
      sources: [
        { kind: "owner-view", viewId: "cvw_77777777-7777-4777-8777-777777777777", generation: 1 },
      ],
      type: "host.integrations.display.demand",
    }),
    {
      channel: "display-data",
      frame: DisplayDataServerMessageSchema.parse({ type: "display.ack", sequence: 1 }),
    },
  ];
}

/** Each new phone frame is parsed by the same union as the Host dispatcher. */
function phoneFrames() {
  const stream = (frame: object) => ({
    channel: "integrations",
    frame: IntegrationsModuleEventSchema.parse({
      ...streamFence,
      streamId: displayStreamId,
      ...frame,
    }),
  });
  return [
    stream({
      type: "runner.integrations.display.source-ended",
      display: "main",
      source: {
        kind: "owner-view",
        viewId: "cvw_77777777-7777-4777-8777-777777777777",
        generation: 1,
      },
      reason: "owner-expired",
    }),
    ...["starting", "live", "protected", "screen-off", "stopped", "failed"].map((state) =>
      stream({
        type: "runner.integrations.display.state",
        display: "main",
        streamId: displayStreamId,
        state,
        ...(state === "protected"
          ? { reason: "locked-screen" }
          : state === "failed"
            ? { reason: "encoder-failed" }
            : {}),
        generation: 1,
        width: 720,
        height: 1280,
        rotation: 0,
      }),
    ),
    stream({
      type: "runner.integrations.display.input-result",
      sessionId: displaySessionId,
      geometry: 1,
      sequence: 0,
      outcome: "refused",
      reason: "unavailable",
    }),
    stream({
      type: "runner.integrations.display.clipboard",
      sessionId: displaySessionId,
      geometry: 1,
      sequence: 1,
      outcome: "copied",
      text: "milk, eggs ✓",
    }),
    stream({
      type: "runner.integrations.display.editing",
      sessionId: displaySessionId,
      geometry: 1,
      context: {
        contextId: "11111111-1111-4111-8111-111111111111",
        field: { kind: "text", multiline: false, sensitive: false, inputMode: "text" },
        caret: { x: 0.25, y: 0.5, height: 0.025 },
      },
    }),
  ];
}

/**
 * Fixed libx264 Constrained Baseline black pictures, 180x320 at 30 fps. The
 * IDR includes SPS/PPS; AUD and SEI are omitted. No encoder runs in this test.
 */
function displayMediaFrames() {
  return [
    {
      key: true,
      codec: "avc1.42C01F",
      sequence: 0,
      ptsUs: 0,
      payloadHex:
        "000000016742c01fda0c0a79fc0440000003004000000f23c60ca80000000168ce0fc80000000165888404bfffff0f4500012fbf27272727272727272727275d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d75d780",
    },
    { key: false, sequence: 1, ptsUs: 33333, payloadHex: "00000001419a2013f01e30" },
  ].map(({ payloadHex, ...fields }) => {
    const header = DisplayMediaFrameHeaderSchema.parse({
      streamId: displayStreamId,
      generation: 1,
      width: 180,
      height: 320,
      ...fields,
    });
    const { streamId: _streamId, ...viewerFields } = header;
    const viewerHeader = DisplayViewerFrameHeaderSchema.parse(viewerFields);
    const payload = Buffer.from(payloadHex, "hex");
    const envelope = encodeDisplayMediaFrame(header, payload);
    const viewerEnvelope = encodeDisplayViewerFrame(viewerHeader, payload);
    expect(decodeDisplayMediaFrame(envelope)).toEqual({ header, payload: new Uint8Array(payload) });
    expect(decodeDisplayViewerFrame(viewerEnvelope)).toEqual({
      header: viewerHeader,
      payload: new Uint8Array(payload),
    });
    return {
      header,
      headerBase64: Buffer.from(JSON.stringify(header), "utf8").toString("base64"),
      payloadBase64: payload.toString("base64"),
      envelopeBase64: Buffer.from(envelope).toString("base64"),
      viewerHeader,
      viewerHeaderBase64: Buffer.from(JSON.stringify(viewerHeader), "utf8").toString("base64"),
      viewerEnvelopeBase64: Buffer.from(viewerEnvelope).toString("base64"),
    };
  });
}

function vectors() {
  const enrollmentInput = {
    challenge,
    credential: { enrollmentToken, kind: "host-enrollment-token" as const },
    descriptor,
    publicKeyPem: canonicalRunnerPublicKeyPem(createPublicKey(runnerKey.privateKey)),
  };
  const definition = getIntegrationDefinition(androidPhoneDefinitionId);
  if (!definition) throw new Error("The catalog must define android-phone");
  return {
    auxiliary: {
      challenge: auxiliaryChallenge,
      signature: createRunnerAuxiliarySignature(runnerKey.privateKey, {
        bootId: descriptor.bootId,
        challenge: auxiliaryChallenge,
        module: "integrations",
        runnerId: descriptor.runnerId,
        ticket: auxiliaryTicket,
      }),
      ticket: auxiliaryTicket,
      ticketDigest: runnerAuxiliaryTicketDigest(auxiliaryTicket),
    },
    hostFrames: hostFrames(),
    phoneFrames: phoneFrames(),
    displayMediaFrames: displayMediaFrames(),
    displayDataTicketClaims: DisplayDataTicketClaimsSchema.parse({
      ...streamFence,
      display: "main",
      streamId: displayStreamId,
      audience: "opensteer-display-data",
      type: "opensteer.display.data-ticket",
      issuedAt: "2026-10-11T12:00:00.000Z",
      expiresAt: new Date(
        Date.parse("2026-10-11T12:00:00.000Z") + displayDataTicketTtlMs,
      ).toISOString(),
      nonce: "F".repeat(43),
    }),
    canonicalJson: canonicalCases.map((inputJson) => ({
      inputJson,
      output: canonicalJson(JSON.parse(inputJson)),
    })),
    contracts: Object.fromEntries(
      parseComputerAppConfig(definition).operations.map((operation) => [
        operation.name,
        computerAppOperationContract(operation),
      ]),
    ),
    runner: {
      proofDescriptors: [
        descriptor,
        {
          ...descriptor,
          future: { é: [null, true, -7, "😀"], a: "  raw  " },
          modules: { ...descriptor.modules, unknown: { kind: "future", version: 3 } },
        },
      ].map((wireDescriptor) => ({
        descriptor: wireDescriptor,
        authentication: createRunnerAuthenticationSignature(runnerKey.privateKey, {
          challenge,
          descriptor: wireDescriptor,
        }),
        enrollment: createRunnerEnrollmentSignature(runnerKey.privateKey, {
          ...enrollmentInput,
          descriptor: wireDescriptor,
        }),
      })),
      authentication: createRunnerAuthenticationSignature(runnerKey.privateKey, {
        challenge,
        descriptor,
      }),
      challenge,
      descriptor,
      enrollment: {
        enrollmentToken,
        enrollmentTokenHash: hashRunnerEnrollmentToken(enrollmentToken),
        signature: createRunnerEnrollmentSignature(runnerKey.privateKey, enrollmentInput),
      },
      key: {
        fingerprint: runnerPublicKeyFingerprint(createPublicKey(runnerKey.privateKey)),
        publicKeyPem: enrollmentInput.publicKeyPem,
        publicKeyRaw: runnerKey.publicKeyRaw,
        seed: runnerKey.seed,
      },
    },
    tokenDigest: { input: auxiliaryTicket, output: tokenDigest(auxiliaryTicket) },
    version: 1,
  };
}

describe("agent phone golden vectors", () => {
  it("match the checked-in fixture the phone's own tests read", () => {
    const actual = `${JSON.stringify(vectors(), null, 2)}\n`;
    if (process.env.OPENSTEER_WRITE_AGENT_PHONE_VECTORS === "1") {
      writeFileSync(fixturePath, actual);
    }
    expect(readFileSync(fixturePath, "utf8")).toBe(actual);
  });
});
