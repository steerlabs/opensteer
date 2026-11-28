import { createId, type RunnerId } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  agentSessionGuardsCapability,
  macOwnerViewVersion,
  mintComputerUseSessionId,
  runnerIntegrationsProtocolVersion,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  type ComputerAppErrorCode,
  type HostIntegrationsOperation,
  type IntegrationsModuleEvent,
  type MachineAppStatus,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryRequestId,
} from "@opensteer/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputerAppHub,
  ComputerAppSubmissionNotStartedError,
  computerAppSubmitTimeoutMs,
  computerUseAnswerGraceMs,
  type ComputerAppControlPeer,
  type ComputerAppInvokeInput,
  type ComputerAppInvokeOutcome,
  type ComputerUseSendInput,
} from "./computer-app-hub.js";
import { releasedRunnerCapabilities } from "./released-runner.test-support.js";

const messages = "apple-messages";
const contract = "a".repeat(43);

function integrationsStream(input: {
  readonly runnerId: RunnerId;
  readonly streamId?: string;
}): RunnerAuxiliaryStream {
  const auxiliaryStreamId = RunnerAuxiliaryStreamIdSchema.parse(
    input.streamId ?? `rax_${globalThis.crypto.randomUUID()}`,
  );
  const fence: RunnerAuxiliaryFrameFence = {
    auxiliaryStreamId,
    bootId: RunnerBootIdSchema.parse(`rbt_${globalThis.crypto.randomUUID()}`),
    connectionGeneration: 1,
    connectionId: RunnerConnectionIdSchema.parse(`rcn_${globalThis.crypto.randomUUID()}`),
    connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${globalThis.crypto.randomUUID()}`),
    module: "integrations",
    runnerId: input.runnerId,
  };
  return {
    auxiliaryStreamId,
    fence,
    identity: {
      name: "example-mac",
      runnerId: input.runnerId,
    } as RunnerAuxiliaryStream["identity"],
    streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function controlPeer(
  options: {
    readonly fail?: boolean;
    readonly notSubmitted?: ConstructorParameters<typeof ComputerAppSubmissionNotStartedError>[1];
    readonly onClose?: () => void;
    readonly send?: () => Promise<void>;
  } = {},
): ComputerAppControlPeer & {
  readonly closes: { code: number; reason: string }[];
  readonly sent: HostIntegrationsOperation[];
} {
  const closes: { code: number; reason: string }[] = [];
  const sent: HostIntegrationsOperation[] = [];
  return {
    closes,
    close: (code, reason) => {
      closes.push({ code, reason });
      options.onClose?.();
    },
    id: `peer:${globalThis.crypto.randomUUID()}`,
    send: async (message) => {
      if (options.notSubmitted !== undefined) {
        throw new ComputerAppSubmissionNotStartedError(
          "WebSocket refused the frame",
          options.notSubmitted,
        );
      }
      sent.push(message);
      if (options.fail) throw new Error("WebSocket callback failed");
      await options.send?.();
    },
    sent,
  };
}

function statusFrame(
  stream: RunnerAuxiliaryStream,
  apps: readonly MachineAppStatus[],
): Extract<IntegrationsModuleEvent, { type: "runner.integrations.status" }> {
  return {
    ...stream.fence,
    apps: [...apps],
    module: "integrations",
    type: "runner.integrations.status",
  };
}

function computerUseResultFrame(
  stream: RunnerAuxiliaryStream,
  requestId: RunnerAuxiliaryRequestId,
  result: Extract<
    IntegrationsModuleEvent,
    { type: "runner.integrations.computer-use-result" }
  >["result"],
): IntegrationsModuleEvent {
  return {
    ...stream.fence,
    module: "integrations",
    requestId,
    result,
    type: "runner.integrations.computer-use-result",
  };
}

function resultFrame(
  stream: RunnerAuxiliaryStream,
  requestId: RunnerAuxiliaryRequestId,
  result: Extract<IntegrationsModuleEvent, { type: "runner.integrations.result" }>["result"],
): IntegrationsModuleEvent {
  return {
    ...stream.fence,
    module: "integrations",
    requestId,
    result,
    type: "runner.integrations.result",
  };
}

function ready(definitionId: string): MachineAppStatus {
  return {
    definitionId,
    operations: [
      {
        detail: null,
        operation: "query_messages",
        remedy: null,
        state: "ready",
      },
    ],
  };
}

/** The last invoke a peer was sent, which is what a result has to name. */
function lastRequestId(peer: ReturnType<typeof controlPeer>): RunnerAuxiliaryRequestId {
  const invokes = peer.sent.filter((message) => message.type === "host.integrations.invoke");
  const last = invokes.at(-1);
  if (!last) throw new Error("No invoke was sent.");
  return last.requestId;
}

describe("ComputerAppHub", () => {
  let hub: ComputerAppHub;
  let changed: number;
  let changedRunners: RunnerId[];
  let known: Set<string>;
  let runnerId: RunnerId;

  beforeEach(() => {
    vi.useFakeTimers();
    changed = 0;
    changedRunners = [];
    known = new Set([messages]);
    runnerId = createId("runner");
    hub = new ComputerAppHub({
      knownDefinitionIds: () => known,
      onChanged: (id) => {
        changedRunners.push(id);
        changed += 1;
      },
    });
  });

  afterEach(() => {
    hub.close();
    vi.useRealTimers();
  });

  function invokeInput(overrides: Partial<ComputerAppInvokeInput> = {}): ComputerAppInvokeInput {
    return {
      access: "read",
      arguments: { limit: 25 },
      contract,
      definitionId: messages,
      effect: "read",
      operation: "query_messages",
      runnerId,
      ...overrides,
    };
  }

  it("negotiates live receiver and authority status and clears them on loss", async () => {
    const peer = controlPeer();
    const base = integrationsStream({ runnerId });
    const stream = {
      ...base,
      identity: {
        ...base.identity,
        modules: {
          integrations: { platform: "darwin", protocolVersion: 5, loginText: 1, passwordSignIn: 2 },
        },
      },
    } as RunnerAuxiliaryStream;
    hub.attach(peer, stream);
    expect(changedRunners).toEqual([runnerId]);
    expect(hub.loginReceiver(runnerId)).toBeNull();
    expect(hub.passwordSignInSupported(runnerId)).toBe(false);
    const key = {
      version: 1 as const,
      connectionId: "helper-1",
      connectionGeneration: 1,
      publicKey: "B" + "A".repeat(86),
    };
    await hub.handleMessage(peer, stream, {
      ...stream.fence,
      module: "integrations",
      type: "runner.integrations.status",
      apps: [],
      loginText: key,
      passwordSignIn: 2,
    });
    expect(hub.loginReceiver(runnerId)).toEqual(key);
    expect(hub.passwordSignInSupported(runnerId)).toBe(true);
    expect(await hub.sendPasswordSignIn(runnerId, { type: "card.probe" })).toEqual({
      type: "unavailable",
    });
    expect(peer.sent.some((frame) => frame.type === "host.integrations.password-sign-in")).toBe(
      false,
    );
    const probe = hub.sendPasswordSignIn(runnerId, {
      type: "signin.probe",
      site: "https://example.com",
    });
    await vi.advanceTimersByTimeAsync(1);
    const frame = peer.sent.find((frame) => frame.type === "host.integrations.password-sign-in");
    if (!frame || frame.type !== "host.integrations.password-sign-in")
      throw new Error("No probe frame");
    await hub.handleMessage(peer, stream, {
      ...stream.fence,
      module: "integrations",
      type: "runner.integrations.password-sign-in-result",
      requestId: frame.requestId,
      result: { type: "signin.probe.result", passwords: "has-login" },
    });
    expect(await probe).toEqual({ type: "signin.probe.result", passwords: "has-login" });
    hub.detach(peer, "transport-disconnected");
    expect(hub.loginReceiver(runnerId)).toBeNull();
    expect(hub.passwordSignInSupported(runnerId)).toBe(false);
  });

  describe("status", () => {
    it("distinguishes a new stream from an empty report and forgets that fact on reconnect", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      expect(hub.reportsApp(runnerId, messages)).toBe("offline");
      hub.attach(peer, stream);
      expect(hub.reportsApp(runnerId, messages)).toBe("connecting");
      await hub.handleMessage(peer, stream, statusFrame(stream, []));
      expect(hub.reportsApp(runnerId, messages)).toBe("absent");
      await hub.handleMessage(
        peer,
        stream,
        statusFrame(stream, [
          {
            definitionId: messages,
            operations: [
              {
                operation: "query_messages",
                state: "permission-required",
                remedy: null,
                detail: "Allow access on this device.",
              },
            ],
          },
        ]),
      );
      expect(hub.reportsApp(runnerId, messages)).toBe("reported");
      expect(hub.reportsApp(runnerId, "unknown-app")).toBe("absent");
      hub.detach(peer, "transport-disconnected");
      expect(hub.reportsApp(runnerId, messages)).toBe("offline");
      hub.attach(controlPeer(), integrationsStream({ runnerId }));
      expect(hub.reportsApp(runnerId, messages)).toBe("connecting");
    });

    it("keeps the last status, drops unknown definitions and stays quiet when it repeats", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const apps = [ready(messages), ready("apple-notes")];
      await hub.handleMessage(peer, stream, statusFrame(stream, apps));
      expect(hub.status(runnerId)).toEqual([ready(messages)]);
      expect(hub.appStatus(runnerId, messages)).toEqual(ready(messages));
      expect(hub.appStatus(runnerId, "apple-notes")).toBeNull();
      expect(changed).toBe(2);

      await hub.handleMessage(peer, stream, statusFrame(stream, apps));
      expect(changed).toBe(2);

      await hub.handleMessage(
        peer,
        stream,
        statusFrame(stream, [
          {
            definitionId: messages,
            operations: [
              {
                detail: "Messages needs Full access.",
                operation: "query_messages",
                remedy: "full-disk-access",
                state: "permission-required",
              },
            ],
          },
        ]),
      );
      expect(changed).toBe(3);
      expect(hub.appStatus(runnerId, messages)?.operations[0]?.state).toBe("permission-required");
    });

    it("forgets what a detached computer reported", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      await hub.handleMessage(peer, stream, statusFrame(stream, [ready(messages)]));
      hub.detach(peer, "transport-disconnected");
      expect(hub.status(runnerId)).toBeNull();
      expect(hub.appStatus(runnerId, messages)).toBeNull();
      expect(changed).toBe(3);
    });

    it("drops app readiness with duplicate or unknown catalog operations", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const operation = ready(messages).operations[0]!;

      await hub.handleMessage(
        peer,
        stream,
        statusFrame(stream, [{ definitionId: messages, operations: [operation, operation] }]),
      );
      expect(hub.appStatus(runnerId, messages)).toBeNull();

      await hub.handleMessage(
        peer,
        stream,
        statusFrame(stream, [
          {
            definitionId: messages,
            operations: [{ ...operation, operation: "delete_everything" }],
          },
        ]),
      );
      expect(hub.appStatus(runnerId, messages)).toBeNull();
    });

    it("refuses a frame from a stream it never admitted", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      await expect(hub.handleMessage(peer, stream, statusFrame(stream, []))).rejects.toThrow(
        "not attached",
      );
    });
  });

  it.each([false, true])(
    "projects phone shared input only when advertised: %s",
    async (sharedInput) => {
      const initial = integrationsStream({ runnerId });
      const stream = {
        ...initial,
        identity: {
          ...initial.identity,
          modules: {
            integrations: {
              platform: "android" as const,
              protocolVersion: 4,
              ...(sharedInput ? { sharedInput: 1 as const } : {}),
            },
          },
        },
      };
      const peer = controlPeer();
      hub.attach(peer, stream);
      await hub.handleMessage(peer, stream, { ...statusFrame(stream, []), displayAvailable: true });
      const live = hub.displayStream(runnerId);
      expect(live).toMatchObject(sharedInput ? { sharedInput: 1 } : {});
      expect(live && live !== "unsupported" ? live.sharedInput : undefined).toBe(
        sharedInput ? 1 : undefined,
      );
    },
  );

  describe("Mac window video", () => {
    // What a Mac's Runner advertises in production: the shared owner-view
    // version in its descriptor and, from its helper, in its status.
    async function attachMac(ownerViewVersion: number | undefined) {
      known = new Set(["macos-app"]);
      const initial = integrationsStream({ runnerId });
      const stream = {
        ...initial,
        identity: {
          ...initial.identity,
          modules: {
            integrations: {
              platform: "darwin" as const,
              protocolVersion: runnerIntegrationsProtocolVersion,
              computerUseVersion: 2 as const,
              macWindowVideoVersion: 1 as const,
              displayProfile: 1 as const,
              ...(ownerViewVersion === undefined ? {} : { ownerViewVersion }),
            },
          },
        },
      };
      const peer = controlPeer();
      hub.attach(peer, stream);
      await hub.handleMessage(peer, stream, {
        ...statusFrame(stream, [ready("macos-app")]),
        ...(ownerViewVersion === undefined ? {} : { ownerViewVersion }),
        displayAvailable: true,
      });
    }

    it("streams a Mac on the owner-view version Macs ship with", async () => {
      await attachMac(macOwnerViewVersion);
      expect(hub.displayStream(runnerId)).toMatchObject({ mac: true, displayProfile: 1 });
    });

    it("still streams a Mac on owner-view version 2", async () => {
      await attachMac(2);
      expect(hub.displayStream(runnerId)).toMatchObject({ mac: true, displayProfile: 1 });
    });

    it("reads a Mac whose helper has not answered as still connecting, then supported once it does", async () => {
      const initial = integrationsStream({ runnerId });
      const stream = {
        ...initial,
        identity: {
          ...initial.identity,
          modules: {
            integrations: {
              platform: "darwin" as const,
              protocolVersion: runnerIntegrationsProtocolVersion,
              computerUseVersion: 2 as const,
              macWindowVideoVersion: 1 as const,
              displayProfile: 1 as const,
              ownerViewVersion: macOwnerViewVersion,
            },
          },
        },
      };
      const peer = controlPeer();
      hub.attach(peer, stream);
      // The first status went out before the helper's handshake.
      await hub.handleMessage(peer, stream, {
        ...statusFrame(stream, [ready(messages)]),
        ownerViewPending: true,
        displayAvailable: false,
      });
      expect(hub.reportsApp(runnerId, messages)).toBe("reported");
      expect(hub.ownerViewSupported(runnerId)).toBe(false);
      expect(hub.ownerViewReported(runnerId)).toBe(false);
      // The helper answers: the same stream, no restart.
      await hub.handleMessage(peer, stream, {
        ...statusFrame(stream, [ready(messages)]),
        ownerViewVersion: macOwnerViewVersion,
        displayAvailable: true,
      });
      expect(hub.ownerViewSupported(runnerId)).toBe(true);
      expect(hub.ownerViewReported(runnerId)).toBe(true);
      expect(hub.displayStream(runnerId)).toMatchObject({ mac: true, displayProfile: 1 });
    });

    it("reads a Mac whose helper answered without the owner-view version as unsupported", async () => {
      await attachMac(undefined);
      expect(hub.ownerViewReported(runnerId)).toBe(true);
      expect(hub.ownerViewSupported(runnerId)).toBe(false);
    });

    it.each([undefined, 1, macOwnerViewVersion + 1])(
      "refuses a Mac whose owner-view version is %s",
      async (ownerViewVersion) => {
        await attachMac(ownerViewVersion);
        expect(hub.displayStream(runnerId)).toBe("unsupported");
      },
    );
  });

  describe("invoking", () => {
    it("answers offline when no stream is attached, without sending anything", async () => {
      expect(await hub.invoke(invokeInput())).toEqual({
        code: "offline",
        kind: "error",
        message: "That computer is offline.",
        retryable: true,
      });
    });

    it("sends one fenced invoke and resolves with its value", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const pending = hub.invoke(invokeInput());
      await vi.advanceTimersByTimeAsync(0);
      const sent = peer.sent[0];
      expect(sent).toMatchObject({
        access: "read",
        arguments: { limit: 25 },
        auxiliaryStreamId: stream.fence.auxiliaryStreamId,
        contract,
        definitionId: messages,
        module: "integrations",
        operation: "query_messages",
        timeoutMs: 60_000,
        type: "host.integrations.invoke",
      });
      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, lastRequestId(peer), { kind: "ok", value: { conversations: [] } }),
      );
      expect(await pending).toEqual({ kind: "ok", value: { conversations: [] } });
    });

    it.each([
      ["invalid-arguments", false],
      ["permission-required", false],
      ["unsupported", false],
      ["busy", true],
      ["failed", false],
      ["outcome-unknown", false],
    ] as const)("passes a %s result through as retryable=%s", async (code, retryable) => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const pending = hub.invoke(invokeInput());
      await vi.advanceTimersByTimeAsync(0);
      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, lastRequestId(peer), {
          code: code satisfies ComputerAppErrorCode,
          kind: "error",
          message: "Messages said no.",
        }),
      );
      expect(await pending).toEqual({
        code,
        kind: "error",
        message: "Messages said no.",
        retryable,
      });
    });

    it("refuses a fifth concurrent call and frees the slot when one finishes", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const inFlight: Promise<ComputerAppInvokeOutcome>[] = [];
      for (let index = 0; index < 4; index += 1) inFlight.push(hub.invoke(invokeInput()));
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.sent).toHaveLength(4);

      expect(await hub.invoke(invokeInput())).toEqual({
        code: "busy",
        kind: "error",
        message: "That computer is already running as many requests as it accepts.",
        retryable: true,
      });
      expect(peer.sent).toHaveLength(4);

      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, lastRequestId(peer), { kind: "ok", value: null }),
      );
      expect(await inFlight[3]).toEqual({ kind: "ok", value: null });
      const admitted = hub.invoke(invokeInput());
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.sent).toHaveLength(5);
      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, lastRequestId(peer), { kind: "ok", value: 1 }),
      );
      expect(await admitted).toEqual({ kind: "ok", value: 1 });
    });

    it("gives up on a read at its deadline and tells the computer to stop", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const pending = hub.invoke(invokeInput({ timeoutMs: 5_000 }));
      await vi.advanceTimersByTimeAsync(0);
      const requestId = lastRequestId(peer);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({
        code: "lost",
        kind: "error",
        message: "That computer did not answer in time.",
        retryable: true,
      });
      expect(peer.sent.at(-1)).toMatchObject({
        module: "integrations",
        requestId,
        type: "host.integrations.cancel",
      });
    });

    it("reports a write whose deadline passed as unknown rather than failed", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const pending = hub.invoke(
        invokeInput({ effect: "write", operation: "send_message", timeoutMs: 5_000 }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({
        code: "outcome-unknown",
        kind: "error",
        message: "That computer did not answer in time.",
        retryable: false,
      });
    });

    it("caps the deadline the computer is given at the protocol maximum", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const pending = hub.invoke(invokeInput({ timeoutMs: 600_000 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.sent[0]).toMatchObject({ timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await pending).kind).toBe("error");
    });

    it("answers an aborted read as lost and an aborted write as unknown", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const readAbort = new AbortController();
      const writeAbort = new AbortController();
      const read = hub.invoke(invokeInput({ signal: readAbort.signal }));
      const write = hub.invoke(
        invokeInput({ effect: "write", operation: "send_message", signal: writeAbort.signal }),
      );
      await vi.advanceTimersByTimeAsync(0);
      readAbort.abort();
      writeAbort.abort();
      expect(await read).toEqual({
        code: "lost",
        kind: "error",
        message: "The request was cancelled.",
        retryable: true,
      });
      expect(await write).toEqual({
        code: "outcome-unknown",
        kind: "error",
        message: "The request was cancelled.",
        retryable: false,
      });
      expect(
        peer.sent.filter((message) => message.type === "host.integrations.cancel"),
      ).toHaveLength(2);
    });

    it("sends nothing for a call that was already cancelled", async () => {
      const peer = controlPeer();
      hub.attach(peer, integrationsStream({ runnerId }));
      const aborted = AbortSignal.abort();
      expect(await hub.invoke(invokeInput({ effect: "write", signal: aborted }))).toEqual({
        code: "lost",
        kind: "error",
        message: "The request was cancelled before it was sent.",
        retryable: true,
      });
      expect(peer.sent).toHaveLength(0);
    });

    it("reports a rejected write submission as unknown because delivery was attempted", async () => {
      const peer = controlPeer({ fail: true });
      hub.attach(peer, integrationsStream({ runnerId }));
      expect(await hub.invoke(invokeInput({ effect: "write", operation: "send_message" }))).toEqual(
        {
          code: "outcome-unknown",
          kind: "error",
          message: "That computer's connection ended while the request was being sent.",
          retryable: false,
        },
      );
    });

    it("keeps a write retryable when the socket refuses it before submission", async () => {
      let peer!: ReturnType<typeof controlPeer>;
      peer = controlPeer({
        notSubmitted: { code: 4009, reason: "slow module consumer" },
        // A transport may publish its close immediately. The invoke must be
        // settled as unsent before that detach applies the in-flight loss rule.
        onClose: () => hub.detach(peer, "transport-disconnected"),
      });
      hub.attach(peer, integrationsStream({ runnerId }));
      expect(await hub.invoke(invokeInput({ effect: "write", operation: "send_message" }))).toEqual(
        {
          code: "offline",
          kind: "error",
          message: "That computer's connection ended before the request was sent.",
          retryable: true,
        },
      );
      expect(peer.sent).toHaveLength(0);
      expect(peer.closes).toEqual([{ code: 4009, reason: "slow module consumer" }]);
    });

    it("keeps a rejected read submission retryable", async () => {
      const peer = controlPeer({ fail: true });
      hub.attach(peer, integrationsStream({ runnerId }));
      expect(await hub.invoke(invokeInput())).toEqual({
        code: "offline",
        kind: "error",
        message: "That computer's connection ended while the request was being sent.",
        retryable: true,
      });
    });

    it("ends a read as lost and a write as unknown when the stream goes", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const read = hub.invoke(invokeInput());
      const write = hub.invoke(invokeInput({ effect: "write", operation: "send_message" }));
      await vi.advanceTimersByTimeAsync(0);
      hub.detach(peer, "transport-disconnected");
      expect(await read).toEqual({
        code: "lost",
        kind: "error",
        message: "That computer went offline.",
        retryable: true,
      });
      expect(await write).toEqual({
        code: "outcome-unknown",
        kind: "error",
        message: "That computer went offline.",
        retryable: false,
      });
    });

    it("says a revoked computer was removed rather than that it went offline", async () => {
      const peer = controlPeer();
      hub.attach(peer, integrationsStream({ runnerId }));
      const pending = hub.invoke(invokeInput());
      await vi.advanceTimersByTimeAsync(0);
      hub.detachRunner(runnerId, "revoked");
      expect(await pending).toEqual({
        code: "lost",
        kind: "error",
        message: "That computer was removed.",
        retryable: true,
      });
      expect(peer.closes).toEqual([{ code: 4003, reason: "integrations stream revoked" }]);
    });

    it("ends a superseded stream's calls and starts the new one empty", async () => {
      const first = controlPeer();
      const firstStream = integrationsStream({ runnerId });
      hub.attach(first, firstStream);
      await hub.handleMessage(first, firstStream, statusFrame(firstStream, [ready(messages)]));
      const pending = hub.invoke(invokeInput({ effect: "write", operation: "send_message" }));
      await vi.advanceTimersByTimeAsync(0);
      const stale = lastRequestId(first);

      // What the registry does on supersession: the old stream is reported lost
      // and the new one attaches.
      hub.detachRunner(runnerId, "superseded");
      const second = controlPeer();
      const secondStream = integrationsStream({ runnerId });
      hub.attach(second, secondStream);

      expect(await pending).toEqual({
        code: "outcome-unknown",
        kind: "error",
        message: "That computer went offline.",
        retryable: false,
      });
      expect(hub.status(runnerId)).toEqual([]);
      // The old computer's answer arrives late; it belongs to nothing here.
      await expect(
        hub.handleMessage(
          first,
          firstStream,
          resultFrame(firstStream, stale, { kind: "ok", value: "sent" }),
        ),
      ).rejects.toThrow("not attached");
      expect(hub.status(runnerId)).toEqual([]);
    });

    it("ignores a result whose request this stream no longer holds", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const pending = hub.invoke(invokeInput());
      await vi.advanceTimersByTimeAsync(0);
      const requestId = lastRequestId(peer);
      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, requestId, { kind: "ok", value: "first" }),
      );
      expect(await pending).toEqual({ kind: "ok", value: "first" });
      // A duplicate, and an id this Host never minted, are both simply dropped.
      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, requestId, { kind: "ok", value: "second" }),
      );
      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, "cai:unknown" as RunnerAuxiliaryRequestId, {
          kind: "ok",
          value: "third",
        }),
      );
    });
  });

  describe("admission", () => {
    it("serialises one computer's turns", async () => {
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = hub.withRunnerAdmission(runnerId, async () => {
        order.push("first-in");
        await gate;
        order.push("first-out");
      });
      const second = hub.withRunnerAdmission(runnerId, () => {
        order.push("second");
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["first-in"]);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-in", "first-out", "second"]);
    });

    it("lets go of the turn once the frame is sent, before the answer arrives", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const order: string[] = [];
      const sent = await hub.withRunnerAdmission(runnerId, async () => {
        order.push("admitted");
        return hub.send(invokeInput());
      });
      await hub.withRunnerAdmission(runnerId, () => {
        order.push("disconnect");
      });
      expect(order).toEqual(["admitted", "disconnect"]);
      await hub.handleMessage(
        peer,
        stream,
        resultFrame(stream, lastRequestId(peer), { kind: "ok", value: "late" }),
      );
      expect(await sent.outcome).toEqual({ kind: "ok", value: "late" });
    });

    it("drops a peer whose invoke submission stalls and releases admission", async () => {
      let settleSend!: () => void;
      const stalled = new Promise<void>((resolve) => {
        settleSend = resolve;
      });
      const peer = controlPeer({ send: () => stalled });
      hub.attach(peer, integrationsStream({ runnerId }));
      const order: string[] = [];
      const first = hub.withRunnerAdmission(runnerId, async () => {
        order.push("invoke");
        return hub.send(
          invokeInput({ effect: "write", operation: "send_message", timeoutMs: 1_000 }),
        );
      });
      const second = hub.withRunnerAdmission(runnerId, () => {
        order.push("queued");
      });

      await vi.advanceTimersByTimeAsync(computerAppSubmitTimeoutMs);
      const sent = await first;
      await second;
      expect(await sent.outcome).toEqual({
        code: "outcome-unknown",
        kind: "error",
        message: "That computer's connection stalled while the request was being sent.",
        retryable: false,
      });
      expect(order).toEqual(["invoke", "queued"]);
      expect(peer.closes).toEqual([
        { code: 1011, reason: "integrations stream submission timed out" },
      ]);
      expect(hub.status(runnerId)).toBeNull();

      settleSend();
      await vi.advanceTimersByTimeAsync(1);
      expect(await sent.outcome).toMatchObject({ code: "outcome-unknown" });
      expect(peer.closes).toHaveLength(1);
    });
  });

  describe("computer use", () => {
    function computerUseInput(overrides: Partial<ComputerUseSendInput> = {}): ComputerUseSendInput {
      return {
        access: "read",
        app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
        operation: "observe",
        params: {},
        runId: createId("run"),
        runnerId,
        sessionId: mintComputerUseSessionId(),
        threadTitle: null,
        ...overrides,
      };
    }

    /** The last computer-use frame a peer was sent. */
    function lastComputerUseRequestId(
      peer: ReturnType<typeof controlPeer>,
    ): RunnerAuxiliaryRequestId {
      const frames = peer.sent.filter(
        (message) => message.type === "host.integrations.computer-use",
      );
      const last = frames.at(-1);
      if (!last) throw new Error("No computer-use frame was sent.");
      return last.requestId;
    }

    it("keeps a fenced audit result after cancellation and bounds its retention", async () => {
      vi.useFakeTimers();
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const abort = new AbortController();
      const sent = await hub.sendComputerUse(
        computerUseInput({
          operation: "act",
          access: "read-write",
          timeoutMs: 1000,
          signal: abort.signal,
        }),
      );
      const id = lastComputerUseRequestId(peer);
      abort.abort();
      expect(await sent.outcome).toMatchObject({ code: "outcome-unknown", abandoned: "cancelled" });
      await hub.handleMessage(
        peer,
        stream,
        computerUseResultFrame(stream, id, {
          kind: "error",
          code: "outcome-unknown",
          message: "The actions may already have taken effect.",
        }),
      );
      const result = {
        kind: "ok" as const,
        value: { performed: ["Clicked Save"], error: { code: "failed", message: "Cancelled" } },
      };
      await hub.handleMessage(peer, stream, computerUseResultFrame(stream, id, result));
      expect(await sent.audit).toEqual(result);
      const nextAbort = new AbortController();
      const pending = await hub.sendComputerUse(
        computerUseInput({
          operation: "act",
          access: "read-write",
          timeoutMs: 1000,
          signal: nextAbort.signal,
        }),
      );
      nextAbort.abort();
      await pending.outcome;
      await vi.advanceTimersByTimeAsync(1000 + computerUseAnswerGraceMs);
      expect(await pending.audit).toMatchObject({ kind: "error", abandoned: "deadline" });
    });
    it("keeps cancelled audit collectors within the existing Runner capacity", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      for (let i = 0; i < 4; i++) {
        const abort = new AbortController();
        const sent = await hub.sendComputerUse(
          computerUseInput({ operation: "act", access: "read-write", signal: abort.signal }),
        );
        abort.abort();
        await sent.outcome;
      }
      const fifth = await hub.sendComputerUse(computerUseInput());
      expect(await fifth.outcome).toMatchObject({ kind: "error", code: "busy" });
    });
    it("delivers a computer-use result to the call waiting on that request", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const sent = await hub.sendComputerUse(computerUseInput());
      const requestId = lastComputerUseRequestId(peer);
      await hub.handleMessage(
        peer,
        stream,
        computerUseResultFrame(stream, requestId, { kind: "ok", value: { observationId: "obs" } }),
      );

      expect(await sent.outcome).toEqual({ kind: "ok", value: { observationId: "obs" } });
    });

    it("refuses a result from a superseded stream and keeps the call waiting", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const sent = await hub.sendComputerUse(computerUseInput());
      const requestId = lastComputerUseRequestId(peer);
      const stale = integrationsStream({ runnerId });

      await expect(
        hub.handleMessage(
          peer,
          stale,
          computerUseResultFrame(stream, requestId, { kind: "ok", value: {} }),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      let settled = false;
      void sent.outcome.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
    });

    it("keeps computer use's own error vocabulary and retries only busy", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const sent = await hub.sendComputerUse(computerUseInput());
      await hub.handleMessage(
        peer,
        stream,
        computerUseResultFrame(stream, lastComputerUseRequestId(peer), {
          code: "stale-observation",
          kind: "error",
          message: "Observe again before acting.",
        }),
      );

      expect(await sent.outcome).toEqual({
        code: "stale-observation",
        kind: "error",
        message: "Observe again before acting.",
        retryable: false,
      });
    });

    it("sends close even when ordinary requests occupy every slot", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      for (let index = 0; index < 4; index += 1) {
        await hub.sendComputerUse(computerUseInput());
      }

      const close = await hub.sendComputerUse(
        computerUseInput({ access: null, app: null, operation: "close", params: {} }),
      );

      expect(peer.sent).toHaveLength(5);
      expect(peer.sent.at(-1)).toMatchObject({ operation: "close" });
      await hub.handleMessage(
        peer,
        stream,
        computerUseResultFrame(stream, lastComputerUseRequestId(peer), {
          kind: "ok",
          value: {},
        }),
      );
      await expect(close.outcome).resolves.toEqual({ kind: "ok", value: {} });
    });

    it("forwards a helper event only from the current fenced stream", async () => {
      const events: unknown[] = [];
      const owned = new ComputerAppHub({
        knownDefinitionIds: () => known,
        onChanged: () => undefined,
        onComputerUseEvent: (eventRunnerId, event) => events.push({ event, eventRunnerId }),
      });
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      const sessionId = mintComputerUseSessionId();
      owned.attach(peer, stream);

      await owned.handleMessage(peer, stream, {
        ...stream.fence,
        event: { event: "session.stopped", params: { reason: "user", sessionId } },
        module: "integrations",
        type: "runner.integrations.computer-use-event",
      });

      expect(events).toEqual([
        {
          event: { event: "session.stopped", params: { reason: "user", sessionId } },
          eventRunnerId: runnerId,
        },
      ]);
      owned.close();
    });

    it("sends the call's deadline and waits a grace past it before giving the answer up", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const sent = await hub.sendComputerUse(computerUseInput({ timeoutMs: 1_000 }));
      expect(peer.sent.at(-1)).toMatchObject({ timeoutMs: 1_000 });
      let settled = false;
      void sent.outcome.then(() => {
        settled = true;
      });

      // The helper may stop at the deadline and still report what it did.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(computerUseAnswerGraceMs);

      expect(await sent.outcome).toEqual({
        abandoned: "deadline",
        code: "failed",
        kind: "error",
        message: "That computer did not answer in time.",
        retryable: true,
      });
      expect(peer.sent.at(-1)).toMatchObject({ type: "host.integrations.cancel" });
    });

    it("marks a cancelled act as abandoned with an unknown outcome", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const controller = new AbortController();
      const sent = await hub.sendComputerUse(
        computerUseInput({
          operation: "act",
          params: { actions: [{ ms: 10, type: "wait" }], observationId: "obs" },
          signal: controller.signal,
        }),
      );

      controller.abort();

      expect(await sent.outcome).toEqual({
        abandoned: "cancelled",
        code: "outcome-unknown",
        kind: "error",
        message: "The request was cancelled.",
        retryable: false,
      });
    });

    it("answers a dropped stream with outcome-unknown for act and failed for observe", async () => {
      const peer = controlPeer();
      const stream = integrationsStream({ runnerId });
      hub.attach(peer, stream);
      const observe = await hub.sendComputerUse(computerUseInput());
      const act = await hub.sendComputerUse(
        computerUseInput({
          operation: "act",
          params: { actions: [{ ms: 10, type: "wait" }], observationId: "obs" },
        }),
      );

      hub.detach(peer, "transport-disconnected");

      expect(await observe.outcome).toEqual({
        code: "failed",
        kind: "error",
        message: "That computer went offline.",
        retryable: true,
      });
      expect(await act.outcome).toEqual({
        code: "outcome-unknown",
        kind: "error",
        message: "That computer went offline.",
        retryable: false,
      });
    });
  });

  it("ends every waiting call and closes every stream when the Host stops", async () => {
    const peer = controlPeer();
    const stream = integrationsStream({ runnerId });
    hub.attach(peer, stream);
    const read = hub.invoke(invokeInput());
    const write = hub.invoke(invokeInput({ effect: "write", operation: "send_message" }));
    await vi.advanceTimersByTimeAsync(0);
    hub.close();
    expect(await read).toMatchObject({ code: "lost", message: "Opensteer is shutting down." });
    expect(await write).toMatchObject({ code: "outcome-unknown" });
    expect(peer.closes).toEqual([{ code: 1001, reason: "Host stopping" }]);
    expect(hub.status(runnerId)).toBeNull();
    expect(await hub.invoke(invokeInput())).toMatchObject({ code: "offline" });
  });
});

describe("screen driver assignment fencing", () => {
  it("routes independent Devices and rejects old generation replies, Stops and dispatch", async () => {
    const { DeviceIdSchema } = await import("@opensteer/core");
    const { DeviceDriverResolver } = await import("../computer-use/device-drivers.js");
    const mac = createId("runner");
    const first = DeviceIdSchema.parse(createId("device"));
    const second = DeviceIdSchema.parse(createId("device"));
    let generation = 1;
    let hub: ComputerAppHub;
    const drivers = new DeviceDriverResolver({
      invalidated: (binding) => hub.invalidateDevice(binding),
      store: {
        getDevice: async (id) => ({ id, removedAt: null, platform: "ios", kind: "phone" }),
        listDeviceDrivers: async () =>
          [first, second].map((deviceId) => ({
            deviceId,
            role: "screen" as const,
            runnerId: mac,
            generation: deviceId === first ? generation : 1,
            detachedAt: null,
          })),
      },
    });
    const events = vi.fn();
    hub = new ComputerAppHub({
      drivers,
      knownDefinitionIds: () => new Set(["iphone-screen"]),
      onChanged: () => undefined,
      onComputerUseEvent: events,
    });
    const peer = controlPeer();
    const base = integrationsStream({ runnerId: mac });
    const stream = {
      ...base,
      identity: {
        ...base.identity,
        modules: {
          integrations: {
            platform: "darwin",
            protocolVersion: runnerIntegrationsProtocolVersion,
            screenDrivers: 1,
          },
        },
      },
    } as RunnerAuxiliaryStream;
    try {
      hub.attach(peer, stream);
      await hub.refreshDeviceDrivers();
      expect(
        peer.sent.find((frame) => frame.type === "host.integrations.device-drivers"),
      ).toMatchObject({
        drivers: [
          { deviceId: first, generation: 1 },
          { deviceId: second, generation: 1 },
        ],
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admission = drivers.withAdmission(first, () => held);
      const frameHandled = hub.handleMessage(peer, stream, {
        ...stream.fence,
        type: "runner.integrations.device-status",
        module: "integrations",
        deviceId: first,
        driverGeneration: 1,
        definitionId: "iphone-screen",
        operations: [],
        availability: { state: "ready", reason: null },
        navigationButtons: [],
        actions: [],
        wake: false,
        lock: null,
        displayVersion: null,
        ownerViewVersion: null,
        inputVersion: null,
        powerVersion: null,
      });
      try {
        await vi.waitFor(
          () =>
            expect(
              hub.deviceStatus(first)?.driverGeneration,
              "status frame must bypass a held Device admission",
            ).toBe(1),
          { timeout: 500 },
        );
      } finally {
        release();
        await admission;
        await frameHandled;
      }
      const old = await hub.captureRoute(first, "iphone-screen");
      const beforeCrossDevice = peer.sent.length;
      const wrongTarget = await hub.sendComputerUse({
        access: "read",
        app: null,
        definitionId: "iphone-screen",
        operation: "observe",
        params: {},
        runId: createId("run"),
        runnerId: second,
        sessionId: mintComputerUseSessionId(),
        threadTitle: null,
        route: old,
      });
      await expect(wrongTarget.outcome).resolves.toMatchObject({ kind: "error" });
      expect(peer.sent).toHaveLength(beforeCrossDevice);

      const send = await hub.sendComputerUse({
        access: "read-write",
        app: null,
        definitionId: "iphone-screen",
        operation: "act",
        params: {},
        runId: createId("run"),
        runnerId: first,
        sessionId: mintComputerUseSessionId(),
        threadTitle: null,
        route: old,
      });
      const frame = peer.sent.find((message) => message.type === "host.integrations.computer-use");
      if (!frame || frame.type !== "host.integrations.computer-use")
        throw new Error("No routed frame");
      expect(frame).toMatchObject({ deviceId: first, driverGeneration: 1, runnerId: mac });
      generation = 2;
      if (!old) throw new Error("No captured screen route");
      await hub.refreshDeviceDrivers();
      expect(hub.attached(second)).toBe(true);
      // A retired captured route cannot dispatch, even while that Runner remains attached.
      const count = peer.sent.length;
      await expect(
        hub
          .sendComputerUse({
            access: "read",
            app: null,
            definitionId: "iphone-screen",
            operation: "observe",
            params: {},
            runId: frame.runId,
            runnerId: first,
            sessionId: frame.sessionId,
            threadTitle: null,
            route: old,
          })
          .then((result) => result.outcome),
      ).resolves.toMatchObject({ kind: "error" });
      expect(peer.sent).toHaveLength(count);
      await hub.handleMessage(peer, stream, {
        ...stream.fence,
        module: "integrations",
        type: "runner.integrations.computer-use-event",
        deviceId: first,
        driverGeneration: 1,
        event: {
          event: "session.stopped",
          params: { sessionId: frame.sessionId, runId: frame.runId, reason: "user" },
        },
      });
      expect(events).not.toHaveBeenCalled();
      const fresh = await hub.captureRoute(first, "iphone-screen");
      const current = await hub.sendComputerUse({
        access: "read",
        app: null,
        definitionId: "iphone-screen",
        operation: "observe",
        params: {},
        runId: frame.runId,
        runnerId: first,
        sessionId: mintComputerUseSessionId(),
        threadTitle: null,
        route: fresh,
      });
      const currentFrame = peer.sent.findLast(
        (item) => item.type === "host.integrations.computer-use",
      );
      if (!currentFrame || currentFrame.type !== "host.integrations.computer-use")
        throw new Error("No current frame");
      let answered = false;
      void current.outcome.then(() => {
        answered = true;
      });
      const result = {
        ...stream.fence,
        module: "integrations" as const,
        type: "runner.integrations.computer-use-result" as const,
        requestId: currentFrame.requestId,
        result: { kind: "ok" as const, value: {} },
      };
      await hub.handleMessage(peer, stream, { ...result, deviceId: first, driverGeneration: 1 });
      await hub.handleMessage(peer, stream, result);
      await Promise.resolve();
      expect(answered).toBe(false);
      const { RunnerIntegrationsDeviceStatusSchema } = await import("@opensteer/protocol");
      const status = RunnerIntegrationsDeviceStatusSchema.parse({
        ...stream.fence,
        type: "runner.integrations.device-status",
        deviceId: first,
        driverGeneration: 2,
        definitionId: "iphone-screen",
        operations: [],
        availability: { state: "ready", reason: null },
        navigationButtons: [],
        actions: [],
        wake: false,
        lock: null,
        displayVersion: 1,
        ownerViewVersion: 1,
        inputVersion: null,
        powerVersion: null,
      });
      await hub.handleMessage(peer, stream, { ...status, driverGeneration: 1 });
      expect(hub.deviceStatus(first)).toBeNull();
      await hub.handleMessage(peer, stream, status);
      hub.invalidateDevice(old);
      expect(hub.deviceStatus(first)?.driverGeneration).toBe(2);
      await hub.handleMessage(peer, stream, { ...result, deviceId: first, driverGeneration: 2 });
      await expect(current.outcome).resolves.toMatchObject({ kind: "ok" });
      hub.close();
      await expect(send.outcome).resolves.toMatchObject({ kind: "error", code: "outcome-unknown" });
    } finally {
      hub.close();
      drivers.close();
    }
  });
});

it("retains the self Device route for Android media without changing its control frames", async () => {
  const { DeviceIdSchema } = await import("@opensteer/core");
  const { DeviceDriverResolver } = await import("../computer-use/device-drivers.js");
  const runnerId = createId("runner");
  const deviceId = DeviceIdSchema.parse(runnerId);
  const drivers = new DeviceDriverResolver({
    store: {
      getDevice: async () => ({
        id: deviceId,
        removedAt: null,
        platform: "android",
        kind: "agent-phone",
      }),
      listDeviceDrivers: async () => [
        { deviceId, role: "self", runnerId, generation: 1, detachedAt: null },
      ],
    },
  });
  const hub = new ComputerAppHub({
    drivers,
    knownDefinitionIds: () => new Set(["android-phone"]),
    onChanged: () => undefined,
  });
  const peer = controlPeer();
  const base = integrationsStream({ runnerId });
  const stream = {
    ...base,
    identity: {
      ...base.identity,
      modules: { integrations: { platform: "android", protocolVersion: 4 } },
    },
  } as RunnerAuxiliaryStream;
  try {
    hub.attach(peer, stream);
    await hub.refreshDeviceDrivers();
    await hub.handleMessage(peer, stream, { ...statusFrame(stream, []), displayAvailable: true });
    const route = await hub.captureRoute(deviceId, "android-phone");
    expect(hub.displayStream(deviceId)).toMatchObject({ route });
    const sent = await hub.sendComputerUse({
      runnerId: deviceId,
      route,
      definitionId: "android-phone",
      access: "read",
      app: null,
      params: { includeScreenshot: false },
      operation: "observe",
      runId: createId("run"),
      sessionId: mintComputerUseSessionId(),
      threadTitle: null,
    });
    const frame = peer.sent.find((frame) => frame.type === "host.integrations.computer-use");
    expect(frame).not.toHaveProperty("deviceId");
    expect(frame).not.toHaveProperty("driverGeneration");
    hub.close();
    await sent.outcome;
  } finally {
    hub.close();
    drivers.close();
  }
});

it("isolates a synchronous assignment send failure from other Runners", async () => {
  const { DeviceDriverResolver } = await import("../computer-use/device-drivers.js");
  const drivers = new DeviceDriverResolver({
    store: { getDevice: async () => null, listDeviceDrivers: async () => [] },
  });
  const hub = new ComputerAppHub({
    drivers,
    knownDefinitionIds: () => new Set(),
    onChanged: () => undefined,
  });
  const bad = controlPeer();
  const good = controlPeer();
  const stream = (runnerId: RunnerId) => {
    const base = integrationsStream({ runnerId });
    return {
      ...base,
      identity: {
        ...base.identity,
        modules: {
          integrations: {
            platform: "darwin",
            protocolVersion: runnerIntegrationsProtocolVersion,
            screenDrivers: 1,
          },
        },
      },
    } as RunnerAuxiliaryStream;
  };
  const first = stream(createId("runner"));
  const second = stream(createId("runner"));
  try {
    hub.attach(bad, first);
    await hub.refreshDeviceDrivers();
    bad.send = () => {
      throw new Error("socket closed synchronously");
    };
    hub.attach(good, second);
    await hub.refreshDeviceDrivers();
    expect(hub.status(first.identity.runnerId)).toBeNull();
    expect(good.closes).toEqual([]);
    expect(good.sent.some((frame) => frame.type === "host.integrations.device-drivers")).toBe(true);
  } finally {
    hub.close();
    drivers.close();
  }
});

describe("a connected agent's guarded operations", () => {
  afterEach(() => vi.useRealTimers());

  function attached(capabilities: readonly string[]) {
    const runnerId = createId("runner");
    const recorded: { runnerId: RunnerId; connectionGeneration: number }[] = [];
    const hub = new ComputerAppHub({
      knownDefinitionIds: () => new Set([messages]),
      onChanged: () => undefined,
      recordRunnerOutdated: async (runner) => {
        recorded.push({ ...runner });
      },
    });
    const peer = controlPeer();
    const base = integrationsStream({ runnerId });
    const stream = {
      ...base,
      identity: {
        ...base.identity,
        capabilities,
        connectionGeneration: 3,
        modules: { integrations: { platform: "darwin", protocolVersion: 5, passwordSignIn: 2 } },
      },
    } as RunnerAuxiliaryStream;
    hub.attach(peer, stream);
    return { hub, peer, recorded, runnerId, stream };
  }

  it("refuses them on a released Runner before any frame, records it, and keeps its stream", async () => {
    vi.useFakeTimers();
    const { hub, peer, recorded, runnerId, stream } = attached(releasedRunnerCapabilities);
    await hub.handleMessage(peer, stream, {
      ...stream.fence,
      module: "integrations",
      type: "runner.integrations.status",
      apps: [],
      passwordSignIn: 2,
    });
    expect(hub.agentSessionGuardsSupported(runnerId)).toBe(false);
    await expect(
      hub.refuseOutdatedForAgentSession(runnerId, "fill a saved login for a connected agent"),
    ).resolves.toBe("Update Opensteer on example-mac to fill a saved login for a connected agent.");
    expect(recorded).toEqual([{ runnerId, connectionGeneration: 3 }]);
    expect(peer.sent).toEqual([]);
    expect(peer.closes).toEqual([]);
    expect(hub.attached(runnerId)).toBe(true);
    // Everything else the computer does keeps going over the same stream.
    const probe = hub.sendPasswordSignIn(runnerId, {
      type: "signin.probe",
      site: "https://example.com",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(peer.sent.map((frame) => frame.type)).toEqual(["host.integrations.password-sign-in"]);
    hub.detach(peer, "transport-disconnected");
    await probe.catch(() => undefined);
    hub.close();
  });

  it("lets them reach a Runner of this release", () => {
    const { hub, recorded, runnerId } = attached([
      ...releasedRunnerCapabilities,
      agentSessionGuardsCapability,
    ]);
    expect(hub.agentSessionGuardsSupported(runnerId)).toBe(true);
    expect(recorded).toEqual([]);
    hub.close();
  });
});
