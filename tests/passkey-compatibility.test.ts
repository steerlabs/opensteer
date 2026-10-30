import { generateKeyPairSync } from "node:crypto";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { afterEach, expect, it, vi } from "vitest";
import { runnerAuxiliaryWelcome } from "../apps/host/src/server/runner-auxiliary-welcome.js";
import { browserViewerMessage } from "../apps/host/src/browser/browser-viewer-protocol.js";
import { PasskeyService, type PasskeyViewer } from "../apps/host/src/browser/passkey-service.js";
import { BrowserRuntime } from "../packages/browser-runtime-core/src/runtime.js";
import {
  FakeLauncher,
  FakeSink,
  FakeTicketVerifier,
  freshClaims,
  testSessionFilesRoot,
} from "../packages/browser-runtime-core/src/test-support/fakes.js";
import {
  BrowserServerMessageSchema,
  createBrowserSessionId,
} from "../packages/protocol/src/browser.js";
import { RunnerAuxiliaryFrameFenceSchema } from "../packages/protocol/src/runner-auxiliary.js";
import type { PasskeyCeremony } from "../packages/protocol/src/passkeys.js";
import {
  previousBrowser,
  previousAuxiliary,
} from "../apps/host/src/browser/test-support/passkey-compatibility/readers.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  [undefined, false],
  ["0", true],
  ["1", false],
  ["1", true],
] as const)("gates the generated Host welcome (flag=%s, advertisement=%s)", (flag, advertised) => {
  vi.stubEnv("OPENSTEER_PASSKEYS", flag);
  const id = "00000000-0000-4000-8000-000000000001";
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    auxiliaryStreamId: `rax_${id}`,
    bootId: `rbt_${id}`,
    connectionGeneration: 1,
    connectionId: `rcn_${id}`,
    connectionLeaseId: `rls_${id}`,
    module: "browser",
    runnerId: `rnr_${id}`,
  });
  const stream = {
    fence,
    streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    identity: {
      modules: {
        browser: {
          runtimeId: "runtime",
          profileSnapshotVersion: 2,
          ...(advertised ? { passkeys: 1 } : {}),
        },
      },
    },
  } as unknown as Parameters<typeof runnerAuxiliaryWelcome>[0];
  const welcome = runnerAuxiliaryWelcome(stream, {}, flag === "1");
  const enabled = flag === "1" && advertised;
  expect(welcome.passkeys).toBe(enabled ? 1 : undefined);
  const signer = new BrowserAttachTicketSigner({
    keyId: "example",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const ticket = signer.issue({
    access: "full-control",
    identity: { kind: "fresh" },
    runtimeId: "runtime",
    sessionId: createBrowserSessionId(),
    subject: "person",
    ...(welcome.passkeys === 1 ? { passkeys: 1 } : {}),
  });
  const payload: unknown = JSON.parse(
    Buffer.from(ticket.split(".")[1]!, "base64url").toString("utf8"),
  );
  expect(previousBrowser.BrowserAttachTicketClaimsSchema!.safeParse(payload).success).toBe(
    !enabled,
  );

  if (!advertised || flag !== "1")
    expect(
      previousAuxiliary.RunnerAuxiliaryWelcomeSchema!.safeParse(JSON.parse(JSON.stringify(welcome)))
        .success,
    ).toBe(true);
  else
    expect(previousAuxiliary.RunnerAuxiliaryWelcomeSchema!.safeParse(welcome).success).toBe(false);
});

it("sends only previous-reader messages from a new runtime when the old Host supplies no signed claim", async () => {
  const launcher = new FakeLauncher();
  const sink = new FakeSink();
  const claims = freshClaims();
  previousBrowser.BrowserAttachTicketClaimsSchema!.parse(JSON.parse(JSON.stringify(claims)));
  const runtime = new BrowserRuntime({
    launcher,
    runtimeId: claims.runtimeId,
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: new FakeTicketVerifier(claims),
    profileStateClient: {
      load: async () => {
        throw new Error("Fresh sessions have no profile");
      },
      commit: async () => {
        throw new Error("Fresh sessions have no profile");
      },
    },
  });
  try {
    await runtime.attach("ticket", sink, { passkeys: true });
    expect(launcher.lastRequest?.authenticator).toBeUndefined();
    expect(sink.messages.length).toBeGreaterThan(0);
  } finally {
    await runtime.shutdown();
  }
  for (const message of sink.messages)
    previousBrowser.BrowserServerMessageSchema!.parse(JSON.parse(JSON.stringify(message)));
});

it("old viewers parse every emitted frame and never receive ceremony, offer, notice, request or withdrawal kinds", async () => {
  const token = "00000000-0000-4000-8000-000000000001";
  const modern = vi.fn();
  const oldFrames: unknown[] = [];
  const old = {
    token: "00000000-0000-4000-8000-000000000002",
    userId: "person",
    fullControl: true,
    mode: undefined,
    surfaceId: "tab",
    live: true,
    authorized: async () => true,
    send: (message) => oldFrames.push(message),
  } satisfies PasskeyViewer;
  const native: PasskeyViewer = { ...old, token, mode: "native", send: modern };
  const viewers: PasskeyViewer[] = [old, native];
  const service = new PasskeyService({
    ownOrigins: () => [],
    viewers: () => viewers,
    result: () => {},
  });
  const ceremony = (cause: PasskeyCeremony["cause"]): PasskeyCeremony => ({
    type: "passkey.ceremony",
    ceremonyId: crypto.randomUUID(),
    surfaceId: "tab",
    documentId: "document",
    op: "get",
    origin: "https://login.example.test",
    rpId: "example.test",
    options: {
      challenge: "AQID",
      allowCredentials: [],
      userVerification: "preferred",
      extensions: {},
    },
    clientDataJSON: "AQID",
    cause,
    deadline: Date.now() + 1000,
  });
  try {
    const snapshot = BrowserServerMessageSchema.parse({
      type: "browser.snapshot",
      sessionId: createBrowserSessionId(),
      access: "full-control",
      state: "ready",
      dialog: null,
      surfaces: [{ id: "tab", active: true, title: "Example", url: "https://login.example.test" }],
      passkeys: "native",
      passkeyConsumerToken: token,
    });
    oldFrames.push(browserViewerMessage(snapshot));
    const direct = ceremony({ person: token });
    service.ceremony(direct);
    service.cancel(direct.ceremonyId);
    for (const cause of ["agent", "unknown"] as const) {
      const offered = ceremony(cause);
      service.ceremony(offered);
      const offer = modern.mock.calls.at(-1)![0];
      await service.viewer(token, { type: "passkey.claim", requestId: offer.requestId });
      service.cancel(offered.ceremonyId);
    }
    native.mode = "notice";
    service.ceremony(ceremony({ person: token }));
    expect(modern.mock.calls.map(([message]) => message.type)).toEqual([
      "browser.passkey.request",
      "browser.passkey.withdrawn",
      "browser.passkey.offer",
      "browser.passkey.request",
      "browser.passkey.withdrawn",
      "browser.passkey.offer",
      "browser.passkey.request",
      "browser.passkey.withdrawn",
      "browser.passkey.notice",
    ]);
    expect(oldFrames).toHaveLength(1);
    for (const message of oldFrames)
      previousBrowser.BrowserServerMessageSchema!.parse(JSON.parse(JSON.stringify(message)));
    expect(
      previousBrowser.BrowserServerMessageSchema!.safeParse(modern.mock.calls[0]![0]).success,
    ).toBe(false);
  } finally {
    service.close();
  }
});
