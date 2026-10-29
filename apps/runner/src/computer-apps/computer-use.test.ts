import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createId } from "@opensteer/core";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import {
  computerAppMaxConcurrentInvokes,
  ComputerUseBridgeRequestSchema,
  LoginReceiverKeySchema,
  SealedLoginEnvelopeSchema,
  IntegrationsModuleEventSchema,
  RunnerAuxiliaryRequestIdSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  ComputerUseSessionIdSchema,
  computerUseUpdateSentence,
  computerUseIconMaxBase64Length,
  computerUseScreenshotMaxBase64Length,
  computerUseScreenshotMaxLongSide,
  computerUseTreeMaxBytes,
  type ComputerAppIdentity,
  type ComputerUseSessionId,
  type ComputerUseBridgeRequest,
  type HostIntegrationsComputerUse,
  type HostIntegrationsComputerAppWindows,
  type IntegrationsModuleEvent,
} from "@opensteer/protocol";
import type { RunnerModuleStream } from "@opensteer/runner-client";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseHandler } from "./computer-use-handler.js";
import { prepareIntegrationsModule } from "./prepare.js";
import {
  createMacosAppProvider,
  computerUseAccessibilitySentence,
  computerUseScreenRecordingSentence,
} from "./macos-app-provider.js";
import { ComputerAppModuleHandler } from "./module-handler.js";
import type { ComputerAppProvider } from "./provider.js";

const fence = {
  auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(
    "rax_00000000-0000-4000-8000-000000000001",
  ),
  bootId: RunnerBootIdSchema.parse("rbt_00000000-0000-4000-8000-000000000002"),
  connectionGeneration: 1,
  connectionId: RunnerConnectionIdSchema.parse("rcn_00000000-0000-4000-8000-000000000003"),
  connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(
    "rls_00000000-0000-4000-8000-000000000004",
  ),
  module: "integrations" as const,
  runnerId: createId("runner"),
};

const runId = createId("run");
const sessionId = ComputerUseSessionIdSchema.parse("cus_00000000-0000-4000-8000-0000000000aa");
const otherSessionId = ComputerUseSessionIdSchema.parse("cus_00000000-0000-4000-8000-0000000000bb");
const notes: ComputerAppIdentity = {
  bundleId: "com.apple.Notes",
  displayName: "Notes",
  teamId: null,
};
const calendar: ComputerAppIdentity = {
  bundleId: "com.apple.iCal",
  displayName: "Calendar",
  teamId: null,
};

const observation = {
  app: notes,
  capturedAt: "2026-09-21T12:00:00.000Z",
  elementCount: 1,
  focusChanged: false,
  geometry: { height: 600, width: 900 },
  snapshot: "obs-1",
  screenshot: null,
  tree: '[0] window "Notes" (0,0 900x600)',
  truncated: false,
  window: {
    ref: "window-1",
    id: 42,
    title: "Notes",
    frame: { x: 0, y: 0, width: 900, height: 600 },
    scale: 1,
  },
  windows: [],
  blockedBy: [],
  alone: false,
} as const;

const bridgeToken = "t".repeat(32);
const threadTitle = "Plan the offsite";
const setupRequestId = "7c1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";
const keyChallenge = {
  challengeId: "0198ab42-5d6e-4f80-9a1b-2c3d4e5f6071",
  expiresAt: "2099-09-21T12:00:30.000Z",
  keyId: `sha256:${"A".repeat(43)}`,
  nonce: "B".repeat(43),
  runnerId: fence.runnerId,
};
const setupRequest = {
  access: "read",
  app: notes,
  createdAt: "2026-09-21T12:00:00.000Z",
  definitionDigest: "digest",
  definitionId: "macos-app",
  deploymentId: createId("deployment"),
  expiresAt: "2026-09-28T12:00:00.000Z",
  id: setupRequestId,
  kind: "app",
  ownerUserId: createId("user"),
  policyAppApproval: null,
  reason: "Read the note.",
  runnerId: fence.runnerId,
  server: null,
  threadId: createId("thread"),
  threadTitle,
  workspaceId: createId("workspace"),
  workspaceName: "Home",
} as const;

const teardown: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close();
  vi.useRealTimers();
});

describe("computer use over the desktop bridge", () => {
  it("preserves a typed owner-window refusal without acquiring a session", async () => {
    const fixture = await setup();
    fixture.bridge.answer("view.windows", () => ({
      error: { code: "app-not-allowed", message: "That app identity changed." },
    }));
    await fixture.handle({
      type: "host.integrations.computer-app-windows",
      requestId: RunnerAuxiliaryRequestIdSchema.parse("owner-refused"),
      timeoutMs: 30_000,
      app: notes,
    });
    await eventually(() =>
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "runner.integrations.computer-app-windows-result",
          requestId: "owner-refused",
          result: { kind: "error", code: "app-not-allowed", message: "That app identity changed." },
        }),
      ),
    );
    expect(methodsOf(fixture.bridge)).toEqual(["view.windows"]);
  });

  it("lists owner windows through the fenced picker frame without opening a session", async () => {
    const fixture = await setup();
    fixture.bridge.answer("view.windows", () => ({
      result: {
        windows: [
          { id: 42, title: "Notes", focused: true, main: true, minimized: false, onScreen: true },
        ],
      },
    }));
    await fixture.handle({
      type: "host.integrations.computer-app-windows",
      requestId: RunnerAuxiliaryRequestIdSchema.parse("owner-windows"),
      timeoutMs: 30_000,
      app: notes,
    });
    await eventually(() =>
      expect(
        fixture.events.some(
          (event) => event.type === "runner.integrations.computer-app-windows-result",
        ),
      ).toBe(true),
    );
    expect(methodsOf(fixture.bridge)).toEqual(["view.windows"]);
    expect(paramsOf(fixture.bridge, "view.windows")).toEqual({ app: notes });
  });

  it("lists owner windows for every app at once without taking a work slot", async () => {
    // A start page asks for each approved app's windows together; a listing
    // only reads what is open, so it never waits on or refuses for agent work.
    const fixture = await setup();
    fixture.bridge.answer("view.windows", () => "hold");
    const lists = computerAppMaxConcurrentInvokes + 1;
    for (let index = 0; index < lists; index += 1)
      await fixture.handle({
        type: "host.integrations.computer-app-windows",
        requestId: RunnerAuxiliaryRequestIdSchema.parse(`owner-windows-${index}`),
        timeoutMs: 30_000,
        app: notes,
      });
    await eventually(() =>
      expect(methodsOf(fixture.bridge).filter((method) => method === "view.windows")).toHaveLength(
        lists,
      ),
    );
    expect(
      fixture.events.filter(
        (event) =>
          event.type === "runner.integrations.computer-app-windows-result" &&
          event.result.kind === "error",
      ),
    ).toEqual([]);
  });

  it("forwards windows, bind and observation refs, and acts without a forced observation", async () => {
    const fixture = await setup();
    await fixture.handle(
      frame("windows", { access: "read-write", app: notes, operation: "windows" }),
    );
    await fixture.settled(1);
    await fixture.handle(
      frame("bind", {
        access: "read-write",
        app: notes,
        operation: "bind",
        params: { window: 42 },
      }),
    );
    await fixture.settled(2);
    await fixture.handle(observeFrame("observe"));
    await fixture.settled(3);
    await fixture.handle(actFrame("act"));
    await fixture.settled(4);
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.windows",
      "session.bind",
      "session.observe",
      "session.act",
    ]);
    expect(paramsOf(fixture.bridge, "session.bind")).toMatchObject({
      window: 42,
      sessionId,
      app: { identity: notes, access: "read-write" },
    });
    expect(paramsOf(fixture.bridge, "session.observe")).toMatchObject({
      window: "window-1",
      includeScreenshot: true,
    });
    expect(paramsOf(fixture.bridge, "session.act")).toMatchObject({
      window: "window-1",
      snapshot: "obs-1",
    });
    expect(paramsOf(fixture.bridge, "session.act")).not.toHaveProperty("includeScreenshot");
    expect(resultFor(fixture.events, "act")?.result).toEqual({
      kind: "ok",
      value: { error: null, performed: ['Clicked "Save"'] },
    });
    await writeFile(
      "/tmp/opensteer-sol-c-wire-journey.json",
      JSON.stringify({ requests: fixture.bridge.requests, events: fixture.events }, null, 2),
    );
  });

  it("advertises implemented protocols through an initial failed probe and recovery on the same connection", async () => {
    const bridge = await startFakeBridge();
    teardown.push(() => bridge.close());
    const prepared = prepareIntegrationsModule({
      computerUseBridge: { token: bridgeToken, url: bridge.url },
      dataDirectory: "/tmp/opensteer-sol-c-descriptor",
      platform: "darwin",
    });
    teardown.push(() => prepared?.close?.());
    const descriptor = JSON.parse(JSON.stringify(prepared?.descriptor));
    expect(descriptor).toMatchObject({ computerUseVersion: 2, ownerViewVersion: 3 });
    bridge.answer("permissions.get", () => ({
      error: { code: "failed", message: "Initial probe failed." },
    }));
    await expect(prepared?.computerUse?.permissions()).rejects.toThrow();
    const provider = prepared?.providers.find(({ definitionId }) => definitionId === "macos-app");
    expect(await provider?.inspect()).toEqual(
      ["observe", "act"].map((operation) => ({
        operation,
        state: "unavailable",
        detail: "Initial probe failed.",
        remedy: null,
      })),
    );
    expect(JSON.parse(JSON.stringify(prepared?.descriptor))).toEqual(descriptor);
    bridge.answer("permissions.get", () => ({
      result: {
        permissions: { accessibility: "granted", screenRecording: "granted" },
        computerUseVersion: 2,
        ownerViewVersion: 3,
      },
    }));
    await prepared?.computerUse?.permissions();
    expect(await provider?.inspect()).toEqual(
      ["observe", "act"].map((operation) => ({
        operation,
        state: "ready",
        detail: null,
        remedy: null,
      })),
    );
    expect(prepared?.descriptor.computerUseVersion).toBe(2);
    expect(prepared?.descriptor.ownerViewVersion).toBe(3);
    prepared?.computerUse?.releaseSessions();
    expect(JSON.parse(JSON.stringify(prepared?.descriptor))).toEqual(descriptor);
  });

  it.each([
    {
      name: "legacy bridge",
      answer: { result: { permissions: { accessibility: "granted", screenRecording: "granted" } } },
      code: "incompatible-version",
      message: computerUseUpdateSentence,
    },
    {
      name: "legacy helper",
      answer: {
        result: {
          permissions: { accessibility: "granted", screenRecording: "granted" },
          ownerViewVersion: 2,
        },
      },
      code: "incompatible-version",
      message: computerUseUpdateSentence,
    },
    {
      name: "transient probe failure",
      answer: { error: { code: "failed", message: "The helper is starting. Try again." } },
      code: "failed",
      message: "The helper is starting. Try again.",
    },
  ])(
    "gates readiness and admission for $name without sending native input",
    async ({ name, answer, code, message }) => {
      const fixture = await setup({ withProvider: true, probe: () => answer });
      await eventually(() => expect(statuses(fixture.events)).toHaveLength(1));
      expect(statuses(fixture.events)[0]?.apps).toEqual([
        {
          definitionId: "macos-app",
          operations: ["observe", "act"].map((operation) => ({
            operation,
            state: "unavailable",
            detail: message,
            remedy: null,
          })),
        },
      ]);
      const calls = [
        frame("unsupported-windows", { operation: "windows", app: notes, access: "read-write" }),
        frame("unsupported-bind", {
          operation: "bind",
          app: notes,
          access: "read-write",
          params: { window: 42 },
        }),
        observeFrame("unsupported-observe"),
        actFrame("unsupported-act"),
      ];
      for (const [index, call] of calls.entries()) {
        await fixture.handle(call);
        await fixture.settled(index + 1);
        expect(resultFor(fixture.events, call.requestId)?.result).toEqual({
          kind: "error",
          code,
          message,
        });
      }
      expect(fixture.bridge.requests.length).toBeGreaterThan(0);
      expect(methodsOf(fixture.bridge).every((method) => method === "permissions.get")).toBe(true);
      expect(fixture.bridge.sockets).toHaveLength(1);
      expect(fixture.logs).toEqual([]);
      await mkdir("/tmp/opensteer-sol-h-capability", { recursive: true });
      await writeFile(
        `/tmp/opensteer-sol-h-capability/${name.replaceAll(" ", "-")}.json`,
        JSON.stringify({ requests: fixture.bridge.requests, events: fixture.events }, null, 2),
      );
    },
  );

  /*
   * Real work is what installs and launches the helper; a status probe never
   * does. Failure mode: a Mac whose helper has not reported support yet
   * refuses every window call, so nothing ever installs the helper and the
   * person is told to grant permissions they may already have given.
   */
  it("keeps negotiated owner capabilities with cached grants and re-reads them after a reconnect", async () => {
    const bridge = await startFakeBridge();
    teardown.push(() => bridge.close());
    let now = 1_000;
    const computerUse = new ComputerUseHandler({
      bridge: { token: bridgeToken, url: bridge.url },
      now: () => now,
    });
    teardown.push(() => computerUse.close());
    const permissions = { accessibility: "granted", screenRecording: "granted" } as const;
    const reads = () => bridge.requests.filter(({ method }) => method === "permissions.get").length;
    bridge.answer("permissions.get", () => ({
      result: { permissions, computerUseVersion: 2, ownerViewVersion: 3, ownerInputVersion: 1 },
    }));
    await computerUse.permissions();
    expect(computerUse.ownerViewVersion()).toBe(3);
    now += 1_000;
    await computerUse.permissions();
    expect(reads()).toBe(1);
    expect(computerUse.ownerViewVersion()).toBe(3);
    bridge.answer("permissions.get", () => ({ result: { permissions, computerUseVersion: 2 } }));
    const lost = new Promise<void>((resolve) => {
      const stop = computerUse.onGrantsChanged(() => {
        stop();
        resolve();
      });
    });
    bridge.dropSockets();
    await lost;
    await computerUse.permissions();
    expect(reads()).toBe(2);
    expect(computerUse.ownerViewVersion()).toBeUndefined();
  });

  it("sends window work to the desktop while no helper has reported support, so real work can install it", async () => {
    const fixture = await setup({
      withProvider: true,
      probe: () => ({
        result: { permissions: { accessibility: "denied", screenRecording: "denied" } },
      }),
    });
    await eventually(() => expect(statuses(fixture.events)).toHaveLength(1));
    expect(statuses(fixture.events)[0]?.apps).toEqual([
      {
        definitionId: "macos-app",
        operations: ["observe", "act"].map((operation) => ({
          operation,
          state: "permission-required",
          detail:
            operation === "act"
              ? computerUseAccessibilitySentence
              : computerUseScreenRecordingSentence,
          remedy: operation === "act" ? "accessibility" : "screen-recording",
        })),
      },
    ]);
    const windows = frame("windows-before-support", {
      operation: "windows",
      app: notes,
      access: "read-write",
    });
    await fixture.handle(windows);
    await fixture.settled(1);
    expect(resultFor(fixture.events, windows.requestId)?.result).toEqual({
      kind: "ok",
      value: { windows: [] },
    });
    expect(methodsOf(fixture.bridge)).toEqual(
      expect.arrayContaining(["permissions.get", "session.open", "session.windows"]),
    );
  });

  it("retries admission after a transient negotiated-support probe failure on the same connection", async () => {
    const fixture = await setup({
      probe: () => ({ error: { code: "failed", message: "The helper is starting." } }),
    });
    await fixture.handle(observeFrame("probe-failed"));
    await fixture.settled(1);
    expect(resultFor(fixture.events, "probe-failed")?.result).toEqual({
      kind: "error",
      code: "failed",
      message: "The helper is starting.",
    });
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get"]);
    fixture.bridge.answer("permissions.get", defaultResponder);
    await fixture.handle(observeFrame("recovered"));
    await fixture.settled(2);
    expect(resultFor(fixture.events, "recovered")?.result).toMatchObject({
      kind: "ok",
      value: { observation },
    });
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "permissions.get",
      "session.open",
      "session.observe",
    ]);
    expect(fixture.bridge.sockets).toHaveLength(1);
  });

  it("spends only the call deadline on negotiated-support admission and opens no session after cancellation", async () => {
    const fixture = await setup();
    let held: { id: number; socket: WebSocket } | undefined;
    fixture.bridge.answer("permissions.get", (request, socket) => {
      held = { id: request.id, socket };
      return "hold";
    });
    await fixture.handle({ ...observeFrame("support-probe"), timeoutMs: 500 });
    await eventually(() => expect(held).toBeDefined());
    expect(fixture.bridge.requests[0]?.timeoutMs).toBeLessThanOrEqual(500);
    await fixture.handle({ requestId: "support-probe", type: "host.integrations.cancel" });
    await fixture.settled(1);
    expect(resultFor(fixture.events, "support-probe")?.result).toMatchObject({
      kind: "error",
      code: "failed",
    });
    if (!held) throw new Error("Missing permissions probe");
    held.socket.send(
      JSON.stringify({
        id: held.id,
        kind: "response",
        result: {
          permissions: { accessibility: "granted", screenRecording: "granted" },
          computerUseVersion: 2,
          ownerViewVersion: 3,
        },
      }),
    );
    await flush();
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get"]);
  });

  it("relays ciphertext/context unchanged and keeps saved-field failures out of frames and logs", async () => {
    const f = await setup({ passwords: true });
    const fixture = z
      .object({ vectors: z.array(z.unknown()) })
      .parse(
        JSON.parse(
          await readFile(
            new URL(
              "../../../../packages/protocol/fixtures/login-envelope-v1.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      );
    const vector = z
      .object({
        receiver: LoginReceiverKeySchema,
        envelope: SealedLoginEnvelopeSchema,
        plaintext: z.string(),
      })
      .parse(fixture.vectors[0]);
    const { receiver, envelope } = vector;
    f.bridge.answer("passwords.capabilities", () => ({ result: { authority: 1, receiver } }));
    const events = f.openStream();
    const canary = vector.plaintext;
    const requestId = envelope.binding.actId;
    const loginContext = { runId: envelope.binding.runId, actId: requestId };
    f.bridge.answer("session.act", () => ({ error: { code: "failed", message: canary } }));
    await f.handle({
      ...actFrame(requestId),
      runId: envelope.binding.runId,
      sessionId: envelope.binding.sessionId,
      params: {
        actions: [{ type: "type", text: { sealed: envelope } }],
        snapshot: "obs-1",
        window: "window-1",
        loginContext,
      },
    });
    await eventually(() => expect(resultFor(events, requestId)).toBeDefined());
    expect(paramsOf(f.bridge, "session.open")).toMatchObject({ runId: envelope.binding.runId });
    expect(paramsOf(f.bridge, "session.act")).toMatchObject({
      loginContext,
      actions: [{ type: "type", text: { sealed: envelope } }],
    });
    await eventually(() =>
      expect(statuses(events).some((status) => status.loginText !== undefined)).toBe(true),
    );
    f.bridge.answer("passwords.capabilities", () => "hold");
    f.bridge.emit({ kind: "event", event: "grants.changed" });
    await eventually(() => expect(statuses(events).at(-1)).not.toHaveProperty("loginText"));
    const raw = JSON.stringify({ frames: f.bridge.requests, events, logs: f.logs });
    expect(raw).not.toContain(canary);
    await writeFile(
      "/tmp/opensteer-wp-b-relay-evidence.json",
      JSON.stringify(
        {
          result: "passed",
          requests: f.bridge.requests,
          events,
          leakMatches: raw.includes(canary) ? 1 : 0,
        },
        null,
        2,
      ),
    );
  });

  it("gates capability status on the welcome opt-in and confirms the live authority", async () => {
    const legacy = await setup();
    await flush();
    expect(methodsOf(legacy.bridge)).not.toContain("passwords.capabilities");
    const modern = await setup({ passwords: true });
    modern.bridge.answer("passwords.capabilities", () => ({
      result: { authority: 1, receiver: null },
    }));
    const current = modern.openStream();
    await eventually(() =>
      expect(
        statuses(current).some((status) => status.passwordSignIn === 1 && !("loginText" in status)),
      ).toBe(true),
    );
  });

  it("refuses a whole saved-text batch when an old helper has no receiver key", async () => {
    const bridge = await startFakeBridge();
    teardown.push(() => bridge.close());
    bridge.answer("passwords.capabilities", () => ({ result: { authority: 1, receiver: null } }));
    const handler = new ComputerUseHandler({ bridge: { token: bridgeToken, url: bridge.url } });
    teardown.push(() => handler.close());
    expect(await handler.passwordsCapabilities()).toEqual({ authority: 1, receiver: null });
    const saved = {
      sealed: {
        binding: {
          version: 1,
          connectionId: "helper",
          connectionGeneration: 1,
          runId,
          sessionId,
          actId: "saved-act",
          actionIndex: 1,
          field: "password",
          expiresAt: Date.now() + 30_000,
        },
        senderPublicKey: "B" + "A".repeat(86),
        salt: "A".repeat(43),
        nonce: "A".repeat(16),
        ciphertext: "",
        tag: "A".repeat(22),
      },
    };
    const request = {
      ...fence,
      ...actFrame("saved-act"),
      params: {
        snapshot: "obs-1",
        window: "window-1",
        loginContext: { runId, actId: "saved-act" },
        actions: [
          { type: "type", text: "visible" },
          { type: "type", text: saved },
        ],
      },
    } as HostIntegrationsComputerUse;
    await expect(handler.run(request, new AbortController().signal)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(methodsOf(bridge)).not.toContain("session.open");
    expect(methodsOf(bridge)).not.toContain("session.act");
  });

  it("reports a helper refusal through the permissions bridge as the actual readiness failure", async () => {
    const bridge = await startFakeBridge();
    teardown.push(() => bridge.close());
    const message = "Opensteer could not verify the computer use helper.";
    bridge.answer("permissions.get", () => ({ error: { code: "failed", message } }));
    const computerUse = new ComputerUseHandler({ bridge: { token: bridgeToken, url: bridge.url } });
    teardown.push(() => computerUse.close());
    const provider = createMacosAppProvider({ permissions: () => computerUse.permissions() });

    expect(await provider.inspect()).toEqual([
      { detail: message, operation: "observe", remedy: null, state: "unavailable" },
      { detail: message, operation: "act", remedy: null, state: "unavailable" },
    ]);
    expect(methodsOf(bridge)).toEqual(["permissions.get"]);
  });

  it("maps every operation to the helper method it belongs to", async () => {
    const fixture = await setup();
    // One at a time: the operations are a sequence a Host performs, and firing
    // them together would only measure the concurrency bound.
    for (const [index, sent] of [
      frame("permissions", { operation: "permissions" }),
      frame("installed", {
        operation: "installed_apps",
        params: { icons: true, limit: 20, offset: 40, query: "note" },
      }),
      frame("resolve", { operation: "resolve_app", params: { app: "Notes" } }),
      { ...observeFrame("observe"), params: { window: "window-1", includeScreenshot: false } },
      actFrame("act"),
      frame("close", { operation: "close" }),
    ].entries()) {
      await fixture.handle(sent);
      await fixture.settled(index + 1);
    }

    expect(fixture.bridge.requests.map(({ method }) => method)).toEqual([
      "permissions.get",
      "apps.installed",
      "app.resolve",
      "session.open",
      "session.observe",
      "session.act",
      "session.close",
    ]);
    expect(paramsOf(fixture.bridge, "apps.installed")).toEqual({
      icons: true,
      limit: 20,
      offset: 40,
      query: "note",
    });
    expect(paramsOf(fixture.bridge, "app.resolve")).toEqual({ app: "Notes" });
    // Opening names only the session and the Thread's title. The app and the
    // access travel with every observe and act, from the frame rather than
    // from anything a model wrote.
    expect(paramsOf(fixture.bridge, "session.open")).toEqual({ sessionId, threadTitle });
    expect(paramsOf(fixture.bridge, "session.observe")).toEqual({
      app: { access: "read-write", identity: notes },
      includeScreenshot: false,
      window: "window-1",
      sessionId,
    });
    expect(paramsOf(fixture.bridge, "session.act")).toEqual({
      actions: [{ text: "Hello", type: "type" }],
      app: { access: "read-write", identity: notes },
      snapshot: "obs-1",
      window: "window-1",
      sessionId,
    });
    // Every request carries what is left of the Host's deadline.
    for (const request of fixture.bridge.requests) {
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(60_000);
    }
    expect(paramsOf(fixture.bridge, "session.close")).toEqual({ sessionId });
    expect(resultFor(fixture.events, "observe")?.result).toEqual({
      kind: "ok",
      value: { observation },
    });
    expect(resultFor(fixture.events, "permissions")?.result).toEqual({
      kind: "ok",
      value: { permissions: { accessibility: "granted", screenRecording: "granted" } },
    });
  });

  it("refuses an unreadable installed-apps request without asking the Mac", async () => {
    const fixture = await setup();
    await fixture.handle(
      frame("installed", { operation: "installed_apps", params: { limit: 500 } }),
    );
    await fixture.settled(1);

    expect(fixture.bridge.requests).toEqual([]);
    expect(resultFor(fixture.events, "installed")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "This installed_apps request could not be read (limit).",
    });
  });

  it("relays the Host's approval list and outcomes to desktop main, and the person's answers back", async () => {
    const fixture = await setup();
    const list = {
      approvalKeyId: null,
      approvals: [{ request: setupRequest }],
    };
    await fixture.handle({ ...list, type: "host.integrations.computer-app-approvals" });
    const outcome = { outcome: { kind: "allowed" }, setupRequestId };
    await fixture.handle({ ...outcome, type: "host.integrations.computer-app-approval-outcome" });
    await eventually(() =>
      expect(methodsOf(fixture.bridge)).toEqual(["approvals.list", "approvals.outcome"]),
    );
    // Neither is a helper call, and neither carries anything the Runner added.
    expect(paramsOf(fixture.bridge, "approvals.list")).toEqual(list);
    expect(paramsOf(fixture.bridge, "approvals.outcome")).toEqual(outcome);
    expect(results(fixture.events)).toEqual([]);

    const approval = {
      expiresAt: "2026-09-21T12:00:30.000Z",
      requestId: setupRequestId,
      signature: "A".repeat(86),
    };
    fixture.bridge.emit({
      event: "approval.answer",
      kind: "event",
      params: { answer: { approval, kind: "allow" }, setupRequestId },
    });
    await eventually(() =>
      expect(
        fixture.events.filter(({ type }) => type.startsWith("runner.integrations.computer-app")),
      ).toEqual([
        // Relaying the list is what connected the bridge, and a desktop this
        // Runner just connected to may have missed a list: it asks again.
        { ...fence, type: "runner.integrations.computer-app-approvals-sync" },
        {
          ...fence,
          answer: { approval, kind: "allow" },
          setupRequestId,
          type: "runner.integrations.computer-app-approval-answer",
        },
      ]),
    );
    // Every connection asks once more, so a desktop that restarted is sent it.
    fixture.bridge.dropSockets();
    await eventually(() => expect(fixture.bridge.sockets).toHaveLength(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fixture.handle({
      approvalKeyId: null,
      approvals: [],
      type: "host.integrations.computer-app-approvals",
    });
    await eventually(() =>
      expect(
        fixture.events.filter(
          ({ type }) => type === "runner.integrations.computer-app-approvals-sync",
        ),
      ).toHaveLength(2),
    );
    // An approval answer is never a helper session event.
    expect(computerUseEvents(fixture.events)).toEqual([]);
  });

  it("drops an approval list quietly when no desktop app is there to show it", async () => {
    const fixture = await setup({ bridge: false });
    await fixture.handle({
      approvalKeyId: null,
      approvals: [],
      type: "host.integrations.computer-app-approvals",
    });
    await flush();
    expect(fixture.bridge.requests).toEqual([]);
    expect(fixture.events.filter(({ type }) => type !== "runner.integrations.status")).toEqual([]);
  });

  it("proves an approval key only with the desktop's answer on the requesting Host stream", async () => {
    const fixture = await setup();
    const proof = { challengeId: keyChallenge.challengeId, signature: "C".repeat(86) };
    fixture.bridge.answer("approvals.key-challenge", () => ({ result: proof }));
    await fixture.handle({
      ...keyChallenge,
      type: "host.integrations.computer-app-approval-key-challenge",
    });
    await eventually(() =>
      expect(fixture.events).toContainEqual({
        ...fence,
        ...proof,
        type: "runner.integrations.computer-app-approval-key-proof",
      }),
    );
    expect(paramsOf(fixture.bridge, "approvals.key-challenge")).toEqual(keyChallenge);
    expect(fixture.bridge.requests.at(-1)?.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(methodsOf(fixture.bridge)).toEqual(["approvals.key-challenge"]);
  });

  it.each([
    { challengeId: setupRequestId, signature: "C".repeat(86) },
    { challengeId: keyChallenge.challengeId, signature: "not a signature" },
  ])("never forwards an invalid or mismatched key proof: %j", async (proof) => {
    const fixture = await setup();
    fixture.bridge.answer("approvals.key-challenge", () => ({ result: proof }));
    await fixture.handle({
      ...keyChallenge,
      type: "host.integrations.computer-app-approval-key-challenge",
    });
    // The next request shares the socket and is answered after the invalid proof.
    await fixture.handle(observeFrame("after-proof"));
    await fixture.settled(1);
    expect(
      fixture.events.some(
        ({ type }) => type === "runner.integrations.computer-app-approval-key-proof",
      ),
    ).toBe(false);
  });

  it("does not carry a pending key proof across Host stream replacement", async () => {
    const fixture = await setup();
    fixture.bridge.answer("approvals.key-challenge", () => "hold");
    await fixture.handle({
      ...keyChallenge,
      type: "host.integrations.computer-app-approval-key-challenge",
    });
    await eventually(() => expect(methodsOf(fixture.bridge)).toContain("approvals.key-challenge"));
    const replacement = fixture.openStream();
    await fixture.handle(observeFrame("replacement"));
    await eventually(() => expect(results(replacement)).toHaveLength(1));
    expect(
      [...fixture.events, ...replacement].some(
        ({ type }) => type === "runner.integrations.computer-app-approval-key-proof",
      ),
    ).toBe(false);
  });

  it("refuses an act that cites no observation before opening a session", async () => {
    const fixture = await setup();
    await fixture.handle(
      frame("no-observation", {
        access: "read-write",
        app: notes,
        operation: "act",
        params: { actions: [{ text: "Hello", type: "type" }], window: "", snapshot: null },
      }),
    );
    await fixture.settled(1);

    expect(fixture.bridge.requests).toEqual([]);
    expect(resultFor(fixture.events, "no-observation")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "This act request could not be read (window).",
    });
  });

  it("opens a session once, whatever app or access each later call names", async () => {
    const fixture = await setup();
    await fixture.handle(observeFrame("notes"));
    await fixture.settled(1);
    await fixture.handle({ ...observeFrame("calendar", calendar), access: "read" });
    await fixture.settled(2);
    await fixture.handle(observeFrame("notes-again"));
    await fixture.settled(3);

    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
      "session.observe",
      "session.observe",
    ]);
    const observed = fixture.bridge.requests
      .filter(({ method }) => method === "session.observe")
      .map(({ params }) => (params as { readonly app: unknown }).app);
    expect(observed).toEqual([
      { access: "read-write", identity: notes },
      { access: "read", identity: calendar },
      { access: "read-write", identity: notes },
    ]);
  });

  it("shares one open between calls that arrive together on a new session", async () => {
    const fixture = await setup();
    await fixture.handle(observeFrame("first"));
    await fixture.handle(observeFrame("second", calendar));
    await fixture.settled(2);

    expect(methodsOf(fixture.bridge).filter((method) => method === "session.open")).toHaveLength(1);
  });

  it("opens again after a refused open, and keeps nothing of it", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.open", () => ({
      error: { code: "permission-required", message: "Turn on macOS Screen Recording." },
    }));
    await fixture.handle(observeFrame("refused"));
    await fixture.settled(1);
    expect(resultFor(fixture.events, "refused")?.result).toMatchObject({
      code: "permission-required",
      kind: "error",
    });

    fixture.bridge.answer("session.open", ({ params }) => ({
      result: { sessionId: (params as { readonly sessionId: unknown }).sessionId },
    }));
    await fixture.handle(observeFrame("retried"));
    await fixture.settled(2);
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.open",
      "session.observe",
    ]);
  });

  it("reports an idle session ended when the desktop bridge disconnects", async () => {
    const fixture = await setup();
    await fixture.handle(observeFrame("observe"));
    await fixture.settled(1);

    fixture.bridge.dropSockets();
    await eventually(() =>
      expect(
        fixture.events.filter((event) => event.type === "runner.integrations.computer-use-event"),
      ).toEqual([
        {
          ...fence,
          type: "runner.integrations.computer-use-event",
          event: { event: "session.stopped", params: { reason: "app-quit", sessionId } },
        },
      ]),
    );

    await fixture.handle(observeFrame("next", notes, otherSessionId));
    await fixture.settled(2);
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
      "permissions.get",
      "session.open",
      "session.observe",
    ]);
  });

  it("forgets a closed session and opens the next one from scratch", async () => {
    const fixture = await setup();
    await fixture.handle(observeFrame("observe"));
    await fixture.settled(1);
    await fixture.handle(frame("close", { operation: "close" }));
    await fixture.settled(2);
    await fixture.handle(observeFrame("after-close", notes, otherSessionId));
    await fixture.settled(3);

    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
      "session.close",
      "session.open",
      "session.observe",
    ]);
  });

  it("refuses an act whose actions this build cannot read before opening a session", async () => {
    const fixture = await setup();
    await fixture.handle(
      frame("invalid", {
        access: "read-write",
        app: notes,
        operation: "act",
        params: { actions: [{ ms: 9_000, type: "wait" }], window: "window-1", snapshot: "obs-1" },
      }),
    );
    await fixture.settled(1);

    expect(fixture.bridge.requests).toEqual([]);
    const result = resultFor(fixture.events, "invalid")?.result;
    expect(result).toMatchObject({ code: "failed", kind: "error" });
    expect(result?.kind === "error" ? result.message : "").toContain("actions.0.type");
  });

  it("passes the Mac's busy answer for an app another task holds through unchanged", async () => {
    const fixture = await setup();
    // Opening is never busy; the app is claimed by the first observe or act.
    fixture.bridge.answer("session.observe", () => ({
      error: { code: "busy", message: "This app is already being used by another task." },
    }));
    await fixture.handle(observeFrame("busy"));
    await fixture.settled(1);

    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
    ]);
    expect(resultFor(fixture.events, "busy")?.result).toEqual({
      code: "busy",
      kind: "error",
      message: "This app is already being used by another task.",
    });
    // Busy is about the app, not the session: the next call uses the same
    // session, and names its app itself as every call does.
    fixture.bridge.answer("session.observe", () => ({ result: { observation } }));
    await fixture.handle(observeFrame("after-busy"));
    await fixture.settled(2);
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
      "session.observe",
    ]);
    expect(resultFor(fixture.events, "after-busy")?.result).toMatchObject({ kind: "ok" });
  });

  it("refuses a fifth concurrent call as the Runner's capacity, never as busy", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.observe", () => "hold");
    for (let index = 0; index < 4; index += 1) {
      await fixture.handle(observeFrame(`parallel-${index}`, notes, otherSessionId));
    }
    await eventually(() =>
      expect(
        fixture.bridge.requests.filter(({ method }) => method === "session.observe"),
      ).toHaveLength(4),
    );
    await fixture.handle(observeFrame("fifth", notes, otherSessionId));
    await fixture.settled(1);

    // `busy` means another task holds the app, and the Host says exactly
    // that to the model; a full Runner is something else.
    expect(resultFor(fixture.events, "fifth")?.result).toEqual({
      code: "failed",
      kind: "error",
      message:
        "The Mac is already running as many computer use requests as it can; try again when one finishes.",
    });
  });

  it("answers cancellation immediately and forwards the late act receipt for audit without retry", async () => {
    const fixture = await setup();
    let held: { id: number; socket: WebSocket } | undefined;
    fixture.bridge.answer("session.act", (request, socket) => {
      held = { id: request.id, socket };
      return "hold";
    });
    await fixture.handle(actFrame("cancelled"));
    await eventually(() => expect(methodsOf(fixture.bridge)).toContain("session.act"));
    await fixture.handle({ requestId: "cancelled", type: "host.integrations.cancel" });
    await fixture.settled(1);

    expect(resultFor(fixture.events, "cancelled")?.result).toEqual({
      code: "outcome-unknown",
      kind: "error",
      message: "The actions may already have taken effect.",
    });
    // There is no cancel on this protocol: the helper finishes the batch it
    // started, and saying anything else here would be a frame it cannot read.
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get", "session.open", "session.act"]);
    if (!held) throw new Error("Missing native batch");
    const partial = {
      performed: ['Clicked "Save"'],
      error: { code: "failed", message: "The next action stopped." },
    };
    held.socket.send(JSON.stringify({ id: held.id, kind: "response", result: partial }));
    await fixture.settled(2);
    expect(results(fixture.events).at(-1)?.result).toEqual({ kind: "ok", value: partial });
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get", "session.open", "session.act"]);
  });

  it("ignores a late answer to a cancelled call and still answers the next one", async () => {
    const fixture = await setup();
    const held: Array<{ readonly id: number; readonly socket: WebSocket }> = [];
    fixture.bridge.answer("session.observe", (request, socket) => {
      held.push({ id: request.id, socket });
      return "hold";
    });
    await fixture.handle(observeFrame("cancelled"));
    await eventually(() => expect(held).toHaveLength(1));
    await fixture.handle({ requestId: "cancelled", type: "host.integrations.cancel" });
    await fixture.settled(1);

    fixture.bridge.answer("session.observe", () => ({ result: { observation } }));
    await fixture.handle(observeFrame("next"));
    await fixture.settled(2);
    // The cancelled call's id is still held here, so this answer to it lands on
    // nothing rather than on the call that took the next id.
    held[0]?.socket.send(
      JSON.stringify({ id: held[0].id, kind: "response", result: { observation } }),
    );
    await flush();

    expect(results(fixture.events)).toHaveLength(2);
    expect(resultFor(fixture.events, "next")?.result).toEqual({
      kind: "ok",
      value: { observation },
    });
  });

  it("gives up a late act as an unknown outcome and ends only its own session", async () => {
    const fixture = await setup({ graceMs: 50 });
    await fixture.handle(observeFrame("mine"));
    await fixture.settled(1);
    await fixture.handle(observeFrame("theirs", calendar, otherSessionId));
    await fixture.settled(2);
    fixture.bridge.answer("session.act", () => "hold");

    await fixture.handle({ ...actFrame("late"), timeoutMs: 100 });
    await fixture.settled(3);

    expect(resultFor(fixture.events, "late")?.result).toEqual({
      code: "outcome-unknown",
      kind: "error",
      message: "The Mac did not answer in time; the actions may already have taken effect.",
    });
    // The helper may still be working on it, so that one session ends on the
    // Mac and for the Host. The socket, which is every Run's, stays.
    await eventually(() => expect(methodsOf(fixture.bridge).at(-1)).toBe("session.close"));
    expect(paramsOf(fixture.bridge, "session.close")).toEqual({ sessionId });
    expect(fixture.bridge.sockets).toHaveLength(1);
    expect(computerUseEvents(fixture.events)).toEqual([
      {
        ...fence,
        type: "runner.integrations.computer-use-event",
        event: { event: "session.stopped", params: { reason: "app-quit", sessionId } },
      },
    ]);

    // The other Run's session carries on without opening again.
    const before = fixture.bridge.requests.length;
    await fixture.handle(observeFrame("theirs-again", calendar, otherSessionId));
    await fixture.settled(4);
    expect(methodsOf(fixture.bridge).slice(before)).toEqual(["session.observe"]);
    expect(resultFor(fixture.events, "theirs-again")?.result).toMatchObject({ kind: "ok" });
  });

  it("gives up a late observe as a plain failure without dropping the bridge", async () => {
    const fixture = await setup({ graceMs: 50 });
    fixture.bridge.answer("session.observe", () => "hold");

    await fixture.handle({ ...observeFrame("late"), timeoutMs: 100 });
    await fixture.settled(1);

    expect(resultFor(fixture.events, "late")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "The Mac did not answer in time.",
    });
    expect(fixture.bridge.sockets).toHaveLength(1);
    // A later call on the same session id opens afresh: the late one ended it.
    fixture.bridge.answer("session.observe", () => ({ result: { observation } }));
    await fixture.handle(observeFrame("after"));
    await fixture.settled(2);
    expect(methodsOf(fixture.bridge).slice(-2)).toEqual(["session.open", "session.observe"]);
  });

  it("abandons a late read on its own, ending no session", async () => {
    const fixture = await setup({ graceMs: 50 });
    await fixture.handle(observeFrame("observe"));
    await fixture.settled(1);
    fixture.bridge.answer("apps.installed", () => "hold");

    await fixture.handle({ ...frame("listing", { operation: "installed_apps" }), timeoutMs: 100 });
    await fixture.settled(2);

    expect(resultFor(fixture.events, "listing")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "The Mac did not answer in time.",
    });
    expect(methodsOf(fixture.bridge)).not.toContain("session.close");
    expect(computerUseEvents(fixture.events)).toEqual([]);
    expect(fixture.bridge.sockets).toHaveLength(1);
  });

  it("never sends a call whose deadline has already passed", async () => {
    const bridge = await startFakeBridge();
    teardown.push(() => bridge.close());
    const computerUse = new ComputerUseHandler({ bridge: { token: bridgeToken, url: bridge.url } });
    teardown.push(() => computerUse.close());

    const late = await computerUse
      .run(
        { ...fence, ...observeFrame("expired") },
        new AbortController().signal,
        Date.now() - 61_000,
      )
      .catch((error: unknown) => error);

    expect(late).toMatchObject({
      code: "failed",
      message: "The request ran out of time before it reached the Mac.",
    });
    expect(bridge.requests).toEqual([]);
  });

  it("forwards only what is left after reconnecting to the desktop", async () => {
    const reconnect = await reconnectingBridge();
    const resolving = reconnect.computerUse.run(
      { ...fence, ...frame("resolve", { operation: "resolve_app", params: { app: "Notes" } }) },
      new AbortController().signal,
      reconnect.clock.at,
    );
    await eventually(() => expect(reconnect.bridge.heldConnections()).toBe(1));
    // Reaching the desktop again took 1.5 s of the Host's 60.
    reconnect.clock.at += 1_500;
    reconnect.bridge.admitConnections();

    await expect(resolving).resolves.toMatchObject({ app: { identity: notes } });
    expect(reconnect.bridge.requests.at(-1)).toMatchObject({
      method: "app.resolve",
      timeoutMs: 58_500,
    });
  });

  it("writes nothing when reconnecting to the desktop outlasts the deadline", async () => {
    const reconnect = await reconnectingBridge();
    const opening = reconnect.computerUse
      .run(
        { ...fence, ...observeFrame("observe") },
        new AbortController().signal,
        reconnect.clock.at,
      )
      .catch((error: unknown) => error);
    await eventually(() => expect(reconnect.bridge.heldConnections()).toBe(1));
    reconnect.clock.at += 61_000;
    reconnect.bridge.admitConnections();

    // Not done, rather than late: nothing reached the Mac, so no session there
    // is ended and none is reported stopped.
    await expect(opening).resolves.toMatchObject({
      code: "failed",
      message: "The request ran out of time before it reached the Mac.",
    });
    expect(methodsOf(reconnect.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
    ]);
  });

  it("reports a bridge lost during an act as an unknown outcome", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.act", () => "hold");
    await fixture.handle(actFrame("act"));
    await eventually(() => expect(methodsOf(fixture.bridge)).toContain("session.act"));
    fixture.bridge.dropSockets();
    await fixture.settled(1);

    expect(resultFor(fixture.events, "act")?.result).toEqual({
      code: "outcome-unknown",
      kind: "error",
      message: "The Mac stopped answering; the actions may already have taken effect.",
    });
  });

  it("reports a bridge lost during an observe as a plain failure and forgets the session", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.observe", () => "hold");
    await fixture.handle(observeFrame("observe"));
    await eventually(() => expect(methodsOf(fixture.bridge)).toContain("session.observe"));
    fixture.bridge.dropSockets();
    await fixture.settled(1);

    expect(resultFor(fixture.events, "observe")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "The Opensteer desktop app stopped answering.",
    });

    // The desktop closes the helper's session when this socket drops, so the
    // next observe must open it again rather than assume it is still there.
    fixture.bridge.answer("session.observe", () => ({ result: { observation } }));
    await fixture.handle(observeFrame("after-loss"));
    await fixture.settled(2);
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
      "permissions.get",
      "session.open",
      "session.observe",
    ]);
  });

  it("ends the sessions of a detached stream on the Mac and forgets them", async () => {
    const fixture = await setup();
    await fixture.handle(observeFrame("notes"));
    await fixture.settled(1);
    await fixture.handle(observeFrame("calendar", calendar, otherSessionId));
    await fixture.settled(2);

    // The helper keeps a session for ten idle minutes, and one Mac runs one at
    // a time, so a detach that only forgot them here would leave the Host that
    // reconnects unable to use its own Mac.
    fixture.handler.detach();
    await eventually(() => expect(fixture.bridge.sockets).toHaveLength(0));

    const next = fixture.openStream();
    await fixture.handle(observeFrame("after-detach"));
    await eventually(() => expect(results(next)).toHaveLength(1));
    expect(methodsOf(fixture.bridge).slice(-2)).toEqual(["session.open", "session.observe"]);
  });

  it("drops the bridge when a detached stream's sessions cannot be ended", async () => {
    const fixture = await setup();
    await fixture.handle(observeFrame("observe"));
    await fixture.settled(1);
    fixture.bridge.answer("session.close", () => ({
      error: { code: "failed", message: "The session could not be ended." },
    }));

    // Nothing else makes the desktop clean up: it closes a Runner's sessions
    // when that Runner's socket goes.
    fixture.handler.detach();
    await eventually(() => expect(fixture.bridge.sockets).toHaveLength(0));
  });

  it("fences a bridge connection that is still opening when its stream detaches", async () => {
    const fixture = await setup();
    let detached = false;
    fixture.bridge.onNextConnection(() => {
      fixture.handler.detach();
      detached = true;
    });
    await fixture.handle(observeFrame("connecting"));
    await eventually(() => expect(detached).toBe(true));
    await eventually(() => expect(fixture.bridge.sockets).toHaveLength(0));
    await flush();
    expect(fixture.bridge.requests).toEqual([]);
    expect(results(fixture.events)).toEqual([]);

    const next = fixture.openStream();
    await fixture.handle(observeFrame("new-stream"));
    await eventually(() => expect(results(next)).toHaveLength(1));
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
    ]);
  });

  it("drops ownership when detached while the first native open is pending", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.open", () => "hold");
    await fixture.handle(observeFrame("opening"));
    await eventually(() =>
      expect(methodsOf(fixture.bridge)).toEqual(["permissions.get", "session.open"]),
    );
    fixture.handler.detach();
    await eventually(() => expect(fixture.bridge.sockets).toHaveLength(0));
    await flush();
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get", "session.open"]);
    expect(results(fixture.events)).toEqual([]);
  });

  it("never observes after a close overtakes a pending open", async () => {
    const fixture = await setup();
    let answerOpen: (() => void) | undefined;
    fixture.bridge.answer("session.open", (request, socket) => {
      answerOpen = () =>
        socket.send(
          JSON.stringify({
            id: request.id,
            kind: "response",
            result: { sessionId },
          }),
        );
      return "hold";
    });
    await fixture.handle(observeFrame("opening"));
    await eventually(() => expect(answerOpen).toBeDefined());
    await fixture.handle(frame("close", { operation: "close" }));
    await fixture.settled(1);
    answerOpen?.();
    await fixture.settled(2);
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get", "session.open", "session.close"]);
    expect(resultFor(fixture.events, "opening")?.result).toMatchObject({
      kind: "error",
      code: "no-session",
    });
  });

  it("admits Stop while cancelled native actions still occupy every work slot", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.act", () => "hold");
    for (let index = 0; index < 4; index += 1) {
      const requestId = `act-${index}`;
      await fixture.handle(actFrame(requestId));
      await eventually(() =>
        expect(
          fixture.bridge.requests.filter(({ method }) => method === "session.act"),
        ).toHaveLength(index + 1),
      );
      await fixture.handle({ requestId, type: "host.integrations.cancel" });
      await fixture.settled(index + 1);
    }
    await fixture.handle(actFrame("fifth"));
    await fixture.settled(5);
    expect(resultFor(fixture.events, "fifth")?.result).toMatchObject({
      kind: "error",
      code: "failed",
    });
    await fixture.handle(frame("stop", { operation: "close" }));
    await fixture.settled(6);
    expect(methodsOf(fixture.bridge).at(-1)).toBe("session.close");
    expect(resultFor(fixture.events, "stop")?.result).toEqual({ kind: "ok", value: {} });
    // An approval list is desktop main's business, never a work slot's.
    await fixture.handle({
      approvalKeyId: null,
      approvals: [],
      type: "host.integrations.computer-app-approvals",
    });
    await eventually(() => expect(methodsOf(fixture.bridge).at(-1)).toBe("approvals.list"));
  });

  it("treats an unreadable action answer as an unknown outcome", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.act", () => ({ result: { observation } }));
    await fixture.handle(actFrame("bad-answer"));
    await fixture.settled(1);
    expect(resultFor(fixture.events, "bad-answer")?.result).toMatchObject({
      kind: "error",
      code: "outcome-unknown",
    });
  });

  it("answers every computer-use frame with one sentence when there is no bridge", async () => {
    const fixture = await setup({ bridge: false });
    await fixture.handle(observeFrame("observe"));
    await fixture.handle(frame("permissions", { operation: "permissions" }));
    await fixture.settled(2);

    for (const requestId of ["observe", "permissions"]) {
      expect(resultFor(fixture.events, requestId)?.result).toEqual({
        code: "unsupported",
        kind: "error",
        message: "Computer use needs the Opensteer desktop app on this Mac.",
      });
    }
  });

  it("guards the frame bound when an answer does not fit, without forwarding it", async () => {
    const fixture = await setup();
    // Twenty icons at the picker's per-app budget: inside every bound the
    // listing's schema states, and past the integrations frame together.
    const icon = "A".repeat(computerUseIconMaxBase64Length);
    fixture.bridge.answer("apps.installed", () => ({
      result: {
        apps: Array.from({ length: 20 }, (_, index) => ({
          iconPng: icon,
          identity: { ...notes, bundleId: `com.example.App${index}` },
          running: false,
        })),
        total: 20,
      },
    }));
    await fixture.handle(
      frame("huge", { operation: "installed_apps", params: { icons: true, limit: 20 } }),
    );
    await fixture.settled(1);

    expect(resultFor(fixture.events, "huge")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "The Mac's answer was too large; ask for fewer results.",
    });
  });

  it("fits the largest observation the helper may send inside one frame", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.observe", () => ({
      result: {
        observation: {
          ...observation,
          screenshot: {
            base64: "A".repeat(computerUseScreenshotMaxBase64Length),
            height: 798,
            mime: "image/jpeg",
            width: computerUseScreenshotMaxLongSide,
          },
          // Every byte a control character, which JSON writes six times over.
          tree: "\u0001".repeat(computerUseTreeMaxBytes),
        },
      },
    }));
    await fixture.handle(observeFrame("largest"));
    await fixture.settled(1);

    expect(resultFor(fixture.events, "largest")?.result).toMatchObject({ kind: "ok" });
  });

  it("refuses an answer it cannot read rather than forwarding the Mac's JSON", async () => {
    const fixture = await setup();
    fixture.bridge.answer("session.observe", () => ({
      result: { observation: { ...observation, elementCount: -1 } },
    }));
    await fixture.handle(observeFrame("unreadable"));
    await fixture.settled(1);

    expect(resultFor(fixture.events, "unreadable")?.result).toEqual({
      code: "failed",
      kind: "error",
      message: "The Mac returned an unexpected answer.",
    });
  });

  it("refuses to open a session the person stopped", async () => {
    const fixture = await setup();
    await fixture.handle(observeFrame("observe"));
    await fixture.settled(1);
    fixture.bridge.emit({
      event: "session.stopped",
      kind: "event",
      params: { reason: "user", sessionId },
    });
    await eventually(() => expect(fixture.bridge.sockets.length).toBeGreaterThan(0));
    await flush();
    await fixture.handle(observeFrame("after-stop"));
    await fixture.settled(2);

    expect(resultFor(fixture.events, "after-stop")?.result).toEqual({
      code: "stopped-by-user",
      kind: "error",
      message: "The person stopped this session.",
    });
    expect(methodsOf(fixture.bridge)).toEqual([
      "permissions.get",
      "session.open",
      "session.observe",
    ]);
    expect(
      fixture.events.filter((event) => event.type === "runner.integrations.computer-use-event"),
    ).toEqual([
      {
        ...fence,
        type: "runner.integrations.computer-use-event",
        event: { event: "session.stopped", params: { reason: "user", sessionId } },
      },
    ]);
  });

  it("advertises app-targeted capture only with a desktop computer-use bridge", () => {
    const prepared = prepareIntegrationsModule({
      computerUseBridge: { token: bridgeToken, url: new URL("http://127.0.0.1:1") },
      dataDirectory: "/tmp/opensteer-capture-descriptor",
      platform: "darwin",
    });
    teardown.push(() => prepared?.close?.());
    expect(prepared?.descriptor).toMatchObject({ macWindowVideoVersion: 1, platform: "darwin" });
    expect(prepared?.descriptor).toHaveProperty("macOwnerInputVersion", 1);
    prepared?.close?.();
    const standalone = prepareIntegrationsModule({
      dataDirectory: "/tmp/opensteer-capture-descriptor",
      platform: "darwin",
    });
    expect(standalone?.descriptor).not.toHaveProperty("macWindowVideoVersion");
    expect(standalone?.descriptor).not.toHaveProperty("macOwnerInputVersion");
    standalone?.close?.();
  });

  it("reports the Mac's grants on the status cadence and refuses an invoke of the app", async () => {
    const fixture = await setup({ withProvider: true });
    await eventually(() => expect(statuses(fixture.events)).toHaveLength(1));
    expect(statuses(fixture.events)[0]?.apps).toEqual([
      {
        definitionId: "macos-app",
        operations: [
          { detail: null, operation: "observe", remedy: null, state: "ready" },
          { detail: null, operation: "act", remedy: null, state: "ready" },
        ],
      },
    ]);
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get"]);

    await fixture.handle(macosAppInvoke("invoke"));
    await eventually(() => expect(invokeResultFor(fixture.events, "invoke")).toBeDefined());
    expect(invokeResultFor(fixture.events, "invoke")?.result).toEqual({
      code: "unsupported",
      kind: "error",
      message: "Computer use operations do not go through invoke.",
    });
    // The refusal is the provider's, not a missing definition: nothing reached
    // the Mac for a call that carries no session, app or access.
    expect(methodsOf(fixture.bridge)).toEqual(["permissions.get"]);
  });
});

interface FakeBridgeAnswer {
  readonly error?: { readonly code: string; readonly message: string };
  readonly result?: unknown;
}

type FakeBridgeResponder = (
  request: ComputerUseBridgeRequest,
  socket: WebSocket,
) => FakeBridgeAnswer | "hold";

/**
 * The desktop's end of the bridge, on a loopback port of its own. It answers
 * the helper's methods, so these tests exercise the real socket, the real
 * frames and the real correlation rather than a stubbed client.
 */
interface FakeBridge {
  /** Completes every connection held since `holdConnections`, and stops holding. */
  admitConnections(): void;
  answer(method: string, responder: FakeBridgeResponder): void;
  close(): Promise<void>;
  dropSockets(): void;
  /** Leaves every new connection mid-handshake, as a desktop that is slow to answer. */
  holdConnections(): void;
  readonly heldConnections: () => number;
  onNextConnection(listener: () => void): void;
  emit(frame: unknown): void;
  readonly requests: readonly ComputerUseBridgeRequest[];
  readonly sockets: readonly WebSocket[];
  readonly url: URL;
}

async function startFakeBridge(): Promise<FakeBridge> {
  let held: (() => void)[] | null = null;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (_info, admit) => {
      if (held) held.push(() => admit(true));
      else admit(true);
    },
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The fake computer use bridge has no port");
  }
  const sockets: WebSocket[] = [];
  const requests: ComputerUseBridgeRequest[] = [];
  const responders = new Map<string, FakeBridgeResponder>();
  server.on("connection", (socket, request) => {
    if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
      socket.close(1008, "unauthorized");
      return;
    }
    sockets.push(socket);
    socket.once("close", () => {
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
    socket.on("message", (raw) => {
      const frame = ComputerUseBridgeRequestSchema.parse(JSON.parse(String(raw)));
      requests.push(frame);
      const answer = (responders.get(frame.method) ?? defaultResponder)(frame, socket);
      if (answer === "hold") return;
      socket.send(JSON.stringify({ id: frame.id, kind: "response", ...answer }));
    });
  });
  const bridge: FakeBridge = {
    admitConnections: () => {
      const waiting = held ?? [];
      held = null;
      for (const admit of waiting) admit();
    },
    answer: (method, responder) => responders.set(method, responder),
    close: async () => {
      bridge.admitConnections();
      for (const socket of sockets) socket.terminate();
      server.close();
      await once(server, "close");
    },
    dropSockets: () => {
      for (const socket of sockets.splice(0)) socket.terminate();
    },
    holdConnections: () => {
      held = [];
    },
    heldConnections: () => held?.length ?? 0,
    emit: (frame) => {
      for (const socket of sockets) socket.send(JSON.stringify(frame));
    },
    onNextConnection: (listener) => {
      server.once("connection", listener);
    },
    requests,
    sockets,
    url: new URL(`ws://127.0.0.1:${address.port}/`),
  };
  return bridge;
}

const defaultResponder: FakeBridgeResponder = (request) => {
  switch (request.method) {
    case "permissions.get":
    case "permissions.request":
      return {
        result: {
          permissions: { accessibility: "granted", screenRecording: "granted" },
          computerUseVersion: 2,
          ownerViewVersion: 3,
        },
      };
    case "apps.installed":
      return { result: { apps: [], total: 0 } };
    case "approvals.list":
    case "approvals.outcome":
      return { result: {} };
    case "app.resolve":
      return {
        result: {
          app: {
            allowed: true,
            identity: notes,
            path: "/System/Applications/Notes.app",
            reason: null,
            risk: "standard",
            running: true,
          },
        },
      };
    case "session.open": {
      const params = request.params as { readonly sessionId: unknown };
      return { result: { sessionId: params.sessionId } };
    }
    case "session.windows":
      return { result: { windows: [] } };
    case "session.bind":
      return {
        result: {
          window: {
            ref: observation.window.ref,
            id: observation.window.id,
            title: observation.window.title,
            frame: observation.window.frame,
            focused: true,
            main: true,
            minimized: false,
            onScreen: true,
            modal: false,
            current: true,
          },
        },
      };
    case "session.observe":
      return { result: { observation } };
    case "session.act":
      return { result: { error: null, performed: ['Clicked "Save"'] } };
    case "session.close":
      return { result: {} };
    default:
      return { error: { code: "unsupported", message: "The fake bridge has no such method." } };
  }
};

/**
 * A handler whose first connection to the desktop was answered and then
 * dropped, with the desktop now slow to take the next one. Its clock moves
 * only when a test moves it, so the `timeoutMs` a frame carries is exact.
 */
async function reconnectingBridge() {
  const bridge = await startFakeBridge();
  teardown.push(() => bridge.close());
  const clock = { at: 1_000_000 };
  const computerUse = new ComputerUseHandler({
    bridge: { token: bridgeToken, url: bridge.url },
    now: () => clock.at,
  });
  teardown.push(() => computerUse.close());
  await computerUse.run(
    { ...fence, ...observeFrame("first") },
    new AbortController().signal,
    clock.at,
  );
  // The session the drop ends is how this end says it noticed.
  const lost = new Promise<void>((resolvePromise) => {
    computerUse.onEvent((event) => {
      if (event.event === "session.stopped") resolvePromise();
    });
  });
  bridge.holdConnections();
  bridge.dropSockets();
  await lost;
  return { bridge, clock, computerUse };
}

async function setup(
  options: {
    readonly bridge?: boolean;
    readonly graceMs?: number;
    readonly passwords?: boolean;
    readonly withProvider?: boolean;
    readonly probe?: FakeBridgeResponder;
  } = {},
): Promise<{
  readonly bridge: FakeBridge;
  readonly events: readonly IntegrationsModuleEvent[];
  readonly logs: unknown[];
  handle(
    message:
      | ComputerUseInput
      | CancelInput
      | InvokeInput
      | Omit<HostIntegrationsComputerAppWindows, keyof typeof fence | "module">,
  ): Promise<void>;
  readonly handler: ComputerAppModuleHandler;
  /** Supersedes the attached stream the way a reconnect does. */
  openStream(): readonly IntegrationsModuleEvent[];
  settled(count: number): Promise<void>;
}> {
  const bridge = await startFakeBridge();
  teardown.push(() => bridge.close());
  if (options.probe) bridge.answer("permissions.get", options.probe);
  const computerUse =
    options.bridge === false
      ? undefined
      : new ComputerUseHandler({
          bridge: { token: bridgeToken, url: bridge.url },
          ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        });
  if (computerUse) teardown.push(() => computerUse.close());
  const providers: readonly ComputerAppProvider[] =
    options.withProvider && computerUse
      ? [createMacosAppProvider({ permissions: async () => await computerUse.permissions() })]
      : [];
  const logs: unknown[] = [];
  const handler = new ComputerAppModuleHandler({
    ...(computerUse ? { computerUse } : {}),
    logger: {
      error: (...args) => {
        logs.push(args);
      },
      info: (...args) => {
        logs.push(args);
      },
    },
    providers,
  });
  teardown.push(() => handler.detach());
  const attach = (): IntegrationsModuleEvent[] => {
    const received: IntegrationsModuleEvent[] = [];
    handler.attach({
      browserAttachPublicKeys: undefined,
      ...(options.passwords ? { loginText: 1 as const, passwordSignIn: 1 as const } : {}),
      fence,
      send: vi.fn(async (payload: Buffer | string) => {
        received.push(IntegrationsModuleEventSchema.parse(JSON.parse(payload.toString())));
      }),
    } satisfies RunnerModuleStream);
    return received;
  };
  const events = attach();
  return {
    bridge,
    events,
    logs,
    handle: async (message) =>
      await handler.handleFrame(Buffer.from(JSON.stringify({ ...fence, ...message })), false),
    handler,
    openStream: () => attach(),
    settled: async (count) =>
      await eventually(() => expect(results(events).length).toBeGreaterThanOrEqual(count)),
  };
}

type ComputerUseInput = Omit<HostIntegrationsComputerUse, keyof typeof fence | "module">;
type CancelInput = { readonly requestId: string; readonly type: "host.integrations.cancel" };
type InvokeInput = Readonly<Record<string, unknown>>;

function frame(requestId: string, overrides: Partial<ComputerUseInput> = {}): ComputerUseInput {
  return {
    access: null,
    app: null,
    operation: "permissions",
    params: {},
    requestId: RunnerAuxiliaryRequestIdSchema.parse(requestId),
    runId,
    sessionId,
    threadTitle,
    timeoutMs: 60_000,
    type: "host.integrations.computer-use",
    ...overrides,
  };
}

function observeFrame(
  requestId: string,
  app: ComputerAppIdentity = notes,
  session: ComputerUseSessionId = sessionId,
): ComputerUseInput {
  return {
    ...frame(requestId, {
      access: "read-write",
      app,
      operation: "observe",
      params: { window: "window-1", includeScreenshot: true },
    }),
    sessionId: session,
  };
}

function actFrame(requestId: string): ComputerUseInput {
  return frame(requestId, {
    access: "read-write",
    app: notes,
    operation: "act",
    params: {
      actions: [{ text: "Hello", type: "type" }],
      snapshot: "obs-1",
      window: "window-1",
    },
  });
}

function macosAppInvoke(requestId: string): InvokeInput {
  const definition = getIntegrationDefinition("macos-app");
  if (!definition || !isComputerAppDefinition(definition)) {
    throw new Error("The computer use definition is missing");
  }
  const operation = definition.config.operations.find(({ name }) => name === "observe");
  if (!operation) throw new Error("The computer use definition has no observe operation");
  return {
    access: "read-write",
    arguments: { operation: "observe", window: "window-1" },
    contract: computerAppOperationContract(operation),
    definitionId: "macos-app",
    operation: "observe",
    requestId: RunnerAuxiliaryRequestIdSchema.parse(requestId),
    timeoutMs: 60_000,
    type: "host.integrations.invoke",
  };
}

function methodsOf(bridge: FakeBridge): readonly string[] {
  return bridge.requests.map(({ method }) => method);
}

function paramsOf(bridge: FakeBridge, method: string): unknown {
  return bridge.requests.find((request) => request.method === method)?.params;
}

function statuses(events: readonly IntegrationsModuleEvent[]) {
  return events.filter((event) => event.type === "runner.integrations.status");
}

function computerUseEvents(events: readonly IntegrationsModuleEvent[]) {
  return events.filter((event) => event.type === "runner.integrations.computer-use-event");
}

function results(events: readonly IntegrationsModuleEvent[]) {
  return events.filter((event) => event.type === "runner.integrations.computer-use-result");
}

function resultFor(events: readonly IntegrationsModuleEvent[], requestId: string) {
  return results(events).find((event) => event.requestId === requestId);
}

function invokeResultFor(events: readonly IntegrationsModuleEvent[], requestId: string) {
  return events
    .filter((event) => event.type === "runner.integrations.result")
    .find((event) => event.requestId === requestId);
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 199) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
