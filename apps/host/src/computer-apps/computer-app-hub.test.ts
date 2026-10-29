import { IntegrationServerIdSchema } from "@opensteer/integration-core";
import { createId, type RunnerId } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
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
        operation: "list_conversations",
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
  let known: Set<string>;
  let runnerId: RunnerId;

  beforeEach(() => {
    vi.useFakeTimers();
    changed = 0;
    known = new Set([messages]);
    runnerId = createId("runner");
    hub = new ComputerAppHub({
      knownDefinitionIds: () => known,
      onChanged: () => {
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
      operation: "list_conversations",
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
          integrations: { platform: "darwin", protocolVersion: 5, loginText: 1, passwordSignIn: 1 },
        },
      },
    } as RunnerAuxiliaryStream;
    hub.attach(peer, stream);
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
      passwordSignIn: 1,
    });
    expect(hub.loginReceiver(runnerId)).toEqual(key);
    expect(hub.passwordSignInSupported(runnerId)).toBe(true);
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
                operation: "list_conversations",
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
                operation: "list_conversations",
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
      expect(hub.displayStream(runnerId)).toMatchObject({ mac: true });
    });

    it("still streams a Mac on owner-view version 2", async () => {
      await attachMac(2);
      expect(hub.displayStream(runnerId)).toMatchObject({ mac: true });
    });

    it.each([undefined, 1, macOwnerViewVersion + 1])(
      "refuses a Mac whose owner-view version is %s",
      async (ownerViewVersion) => {
        await attachMac(ownerViewVersion);
        expect(hub.displayStream(runnerId)).toBe("unsupported");
      },
    );
  });

  it("keeps iPhone protocol 1 data-only despite unsupported live status fields", async () => {
    known = new Set(["apple-calendar", messages, "android-phone", "macos-app"]);
    const initial = integrationsStream({ runnerId });
    const stream = {
      ...initial,
      identity: {
        ...initial.identity,
        modules: {
          integrations: {
            platform: "ios" as const,
            protocolVersion: 1,
            computerAppApprovals: true as const,
          },
        },
      },
    };
    const peer = controlPeer();
    hub.attach(peer, stream);
    await hub.handleMessage(peer, stream, {
      ...statusFrame(stream, [
        ready(messages),
        {
          definitionId: "apple-calendar",
          operations: [{ operation: "list_calendars", state: "ready", detail: null, remedy: null }],
        },
      ]),
      ownerViewVersion: 1,
      displayAvailable: true,
      passwordSignIn: 1,
    });
    expect(hub.status(runnerId)?.map(({ definitionId }) => definitionId)).toEqual([
      "apple-calendar",
    ]);
    expect(hub.relaysComputerAppApprovals(runnerId)).toBe(true);
    expect(hub.approvalRelayRefusal(runnerId)).toBeNull();
    expect(hub.loginReceiver(runnerId)).toBeNull();
    expect(hub.passwordSignInSupported(runnerId)).toBe(false);
    expect(hub.ownerViewSupported(runnerId)).toBe(false);
    expect(hub.displayStream(runnerId)).toBeNull();
    await expect(
      hub.openMcpSession({
        runnerId,
        launch: { type: "stdio", command: "node", args: [], cwd: "/tmp", env: {} },
        serverId: IntegrationServerIdSchema.parse(`isv_${globalThis.crypto.randomUUID()}`),
        signal: new AbortController().signal,
        onclose: () => undefined,
        onmessage: () => undefined,
      }),
    ).rejects.toThrow("Local servers can't run on an iPhone.");
    const sent = await hub.sendComputerUse({
      runnerId,
      operation: "close",
      app: null,
      access: "read",
      params: {},
      runId: createId("run"),
      sessionId: mintComputerUseSessionId(),
      threadTitle: null,
    });
    expect(await sent.outcome).toMatchObject({ kind: "error", code: "unsupported" });
    expect(peer.sent).toEqual([]);
  });

  describe("approval key registration", () => {
    // A legacy/future descriptor must remain connected without receiving a
    // schema it cannot parse, including approved MCP launches from storage.
    it.each([undefined, 1, 3])(
      "does not send new approval or MCP frames to protocol %s",
      async (protocolVersion) => {
        const peer = controlPeer();
        const initial = integrationsStream({ runnerId });
        const stream = {
          ...initial,
          identity: {
            ...initial.identity,
            modules: {
              integrations: {
                computerAppApprovals: true as const,
                platform: "darwin" as const,
                ...(protocolVersion === undefined ? {} : { protocolVersion }),
              },
            },
          },
        };
        hub.attach(peer, stream);
        expect(hub.relaysComputerAppApprovals(runnerId)).toBe(false);
        expect(
          await hub.sendComputerAppApprovals(runnerId, { approvalKeyId: null, approvals: [] }),
        ).toBe(false);
        expect(await hub.proveComputerAppApprovalKey(runnerId, challenge())).toBeNull();
        await expect(
          hub.openMcpSession({
            launch: { args: [], command: "node", cwd: "/tmp", env: {}, type: "stdio" },
            onclose: () => undefined,
            onmessage: () => undefined,
            runnerId,
            serverId: IntegrationServerIdSchema.parse(`isv_${globalThis.crypto.randomUUID()}`),
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("Update Opensteer");
        expect(peer.sent).toEqual([]);
        expect(peer.closes).toEqual([]);
        expect(hub.attached(runnerId)).toBe(true);
      },
    );

    it.each([
      ["darwin", "Update Opensteer on this Mac and open its desktop app to approve access."],
      ["android", null],
    ] as const)(
      "requires an approval relay only for an attached Mac (%s)",
      (platform, sentence) => {
        expect(hub.approvalRelayRefusal(runnerId)).toBeNull();
        const initial = integrationsStream({ runnerId });
        hub.attach(controlPeer(), {
          ...initial,
          identity: {
            ...initial.identity,
            modules: {
              integrations: { computerAppApprovals: true as const, platform, protocolVersion: 1 },
            },
          },
        });
        expect(hub.approvalRelayRefusal(runnerId)).toBe(sentence);
      },
    );

    it("refuses nothing for a computer that shows approvals", () => {
      hub.attach(controlPeer(), approvalStream());
      expect(hub.approvalRelayRefusal(runnerId)).toBeNull();
    });

    function approvalStream(): RunnerAuxiliaryStream {
      const stream = integrationsStream({ runnerId });
      return {
        ...stream,
        identity: {
          ...stream.identity,
          modules: {
            integrations: { computerAppApprovals: true, platform: "darwin", protocolVersion: 5 },
          },
        } as RunnerAuxiliaryStream["identity"],
      };
    }

    function challenge() {
      return {
        challengeId: globalThis.crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        keyId: `sha256:${"k".repeat(43)}`,
        nonce: "n".repeat(43),
        runnerId,
      };
    }

    it("accepts one proof from the currently fenced stream", async () => {
      const peer = controlPeer();
      const stream = approvalStream();
      hub.attach(peer, stream);
      const asked = challenge();
      const pending = hub.proveComputerAppApprovalKey(runnerId, asked);
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.sent.at(-1)).toMatchObject({
        challengeId: asked.challengeId,
        type: "host.integrations.computer-app-approval-key-challenge",
      });
      await hub.handleMessage(peer, stream, {
        ...stream.fence,
        challengeId: asked.challengeId,
        module: "integrations",
        signature: "s".repeat(86),
        type: "runner.integrations.computer-app-approval-key-proof",
      });
      await expect(pending).resolves.toBe("s".repeat(86));
      // A replay cannot settle the next registration's different challenge.
      const second = challenge();
      const next = hub.proveComputerAppApprovalKey(runnerId, second);
      await vi.advanceTimersByTimeAsync(0);
      await hub.handleMessage(peer, stream, {
        ...stream.fence,
        challengeId: asked.challengeId,
        module: "integrations",
        signature: "s".repeat(86),
        type: "runner.integrations.computer-app-approval-key-proof",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(next).resolves.toBeNull();
    });

    it("fails when the stream drops and refuses the old stream after replacement", async () => {
      const firstPeer = controlPeer();
      const firstStream = approvalStream();
      hub.attach(firstPeer, firstStream);
      const asked = challenge();
      const pending = hub.proveComputerAppApprovalKey(runnerId, asked);
      await vi.advanceTimersByTimeAsync(0);
      const secondPeer = controlPeer();
      const secondStream = approvalStream();
      hub.attach(secondPeer, secondStream);
      await expect(pending).resolves.toBeNull();
      await expect(
        hub.handleMessage(firstPeer, firstStream, {
          ...firstStream.fence,
          challengeId: asked.challengeId,
          module: "integrations",
          signature: "s".repeat(86),
          type: "runner.integrations.computer-app-approval-key-proof",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("retires a stream whose approval control frame failed to send", async () => {
      const peer = controlPeer({ fail: true });
      const stream = approvalStream();
      hub.attach(peer, stream);
      const delivered = await hub.sendComputerAppApprovals(runnerId, {
        approvalKeyId: null,
        approvals: [],
      });
      expect(delivered).toBe(false);
      expect(hub.attached(runnerId)).toBe(false);
      expect(peer.closes).toEqual([
        { code: 1011, reason: "integrations control frame could not be sent" },
      ]);
    });
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
        operation: "list_conversations",
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
