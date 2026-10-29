import {
  HarnessIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
} from "@opensteer/core";
import {
  CorrelationIdSchema,
  HarnessInstanceCatalogSchema,
  RunnerCommandSchema,
  type HostToRunnerMessage,
  type RunnerAuxiliaryTicketClaims,
  type RunnerCommand,
  type RunnerConnectionFence,
  type HarnessSourceDescriptor,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  RunnerRegistry,
  runnerIdentityRevokedCloseCode,
  runnerIdentityRevokedMessage,
  type RunnerDisconnectScope,
  type RunnerIdentity,
  type RunnerPeer,
  type RunnerRegistryHooks,
} from "./index.js";

describe("Runner connection registry", () => {
  it("updates the macOS shell fact without changing the connection fence", async () => {
    const hook = vi.fn(async () => undefined);
    const registry = new RunnerRegistry({
      hooks: {
        authorize: vi.fn(async () => undefined),
        onEvent: vi.fn(async () => undefined),
        onShellFullDiskAccess: hook,
      },
    });
    const original = hello(createId("runner"), createId("environment"), "boot-1");
    const peer = new MemoryRunnerPeer("mac");
    await registerAttached(
      registry,
      {
        ...original,
        modules: {
          ...original.modules,
          shell: { hostPublicKey: "ssh-ed25519 AAAA", platform: "darwin", fullDiskAccess: false },
        },
      },
      peer,
    );
    const before = registry.identityForRunner(original.runnerId);
    await registry.handle(peer, {
      ...fenceOf(peer),
      type: "runner.shell.full-disk-access",
      fullDiskAccess: true,
    });
    const identity = registry.identityForRunner(original.runnerId);
    expect(identity).toEqual({
      ...before,
      modules: { ...before?.modules, shell: { ...before?.modules.shell, fullDiskAccess: true } },
    });
    expect(identity?.fence).toBe(before?.fence);
    expect(hook).toHaveBeenCalledWith(identity, true);
    await registry.handle(peer, {
      ...fenceOf(peer),
      type: "runner.shell.full-disk-access",
      fullDiskAccess: false,
    });
    expect(hook).toHaveBeenLastCalledWith(registry.identityForRunner(original.runnerId), false);
  });

  it.each(["missing", "linux"] as const)(
    "refuses full access reports from a %s shell",
    async (platform) => {
      const hook = vi.fn(async () => undefined);
      const registry = new RunnerRegistry({
        hooks: {
          authorize: vi.fn(async () => undefined),
          onEvent: vi.fn(async () => undefined),
          onShellFullDiskAccess: hook,
        },
      });
      const original = hello(createId("runner"), createId("environment"), "boot-1");
      const peer = new MemoryRunnerPeer("other");
      await registerAttached(
        registry,
        {
          ...original,
          modules: {
            ...original.modules,
            ...(platform === "linux"
              ? { shell: { hostPublicKey: "ssh-ed25519 AAAA", platform } }
              : {}),
          },
        },
        peer,
      );
      await expect(
        registry.handle(peer, {
          ...fenceOf(peer),
          type: "runner.shell.full-disk-access",
          fullDiskAccess: true,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Runner reported Full Disk Access without a macOS shell module",
      });
      expect(hook).not.toHaveBeenCalled();
    },
  );

  it("replaces a prior boot and fences the old peer", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(
        async (_identity: RunnerIdentity, _scope: RunnerDisconnectScope) => undefined,
      ),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const first = new MemoryRunnerPeer("first");
    const second = new MemoryRunnerPeer("second");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), first);
    await registerAttached(registry, hello(runnerId, environmentId, "boot-2"), second);
    expect(first.closed).toMatchObject({ code: 4001 });
    expect(hooks.onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ bootId: "boot-1", runnerId }),
      { reason: "replaced", runIds: [], triggerOccurrenceIds: [] },
    );
    expect(registry.identityForEnvironment(environmentId)?.bootId).toBe("boot-2");
    expect(registry.identityForRunner(runnerId)?.bootId).toBe("boot-2");
  });

  it("fences a revoked Runner and rejects every later registration", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const first = new MemoryRunnerPeer("first");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), first);

    await registry.revoke(runnerId);

    // The one terminal code, distinct from every refusal a Runner should
    // retry, so the computer supervising it knows to clear the slot.
    expect(first.closed).toEqual({
      code: runnerIdentityRevokedCloseCode,
      reason: runnerIdentityRevokedMessage,
    });
    expect(registry.isRunnerConnected(runnerId)).toBe(false);
    expect(registry.isAvailable(environmentId)).toBe(false);
    await expect(
      registry.register(hello(runnerId, environmentId, "boot-2"), new MemoryRunnerPeer("second")),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects registration when revocation races the durable authorization hook", async () => {
    let releaseAuthorization!: () => void;
    const authorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const hooks = {
      authorize: vi.fn(async () => authorization),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const registering = registry.register(
      hello(runnerId, environmentId, "boot-1"),
      new MemoryRunnerPeer("runner"),
    );
    await waitFor(() => hooks.authorize.mock.calls.length === 1);

    await registry.revoke(runnerId);
    const rejected = expect(registering).rejects.toMatchObject({ code: "forbidden" });
    releaseAuthorization();

    await rejected;
    expect(registry.isRunnerConnected(runnerId)).toBe(false);
  });

  it("fails a steer for an offline environment instead of retrying it forever", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const environmentId = createId("environment");
    const commandId = createId("command");

    await expect(
      registry.dispatch(
        RunnerCommandSchema.parse({
          commandId,
          correlationId: CorrelationIdSchema.parse(commandId),
          environmentId,
          input: {
            author: {
              displayName: "Research agent",
              kind: "agent",
              runId: createId("run"),
              threadId: createId("thread"),
              workspaceId: createId("workspace"),
              workspaceName: "Research",
            },
            content: [{ text: "Deliver into the active turn", type: "text" }],
            createdAt: new Date().toISOString(),
            kind: "input",
            messageId: createId("message"),
          },
          runId: createId("run"),
          threadId: createId("thread"),
          type: "run.steer",
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ disposition: "failed", message: "Runner is offline" });
  });

  it("holds a command receipt behind its response-specific durable commit hook", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onCommandAccepted: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 1_000 });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const commandId = createId("command");
    const command = RunnerCommandSchema.parse({
      commandId,
      correlationId: CorrelationIdSchema.parse(commandId),
      environmentId,
      runId: createId("run"),
      threadId: createId("thread"),
      type: "run.interrupt",
    });
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const beforeAck = vi.fn(async () => commit);
    let dispatchFinished = false;
    const dispatch = registry
      .dispatch(command, new AbortController().signal, { beforeAck })
      .then(() => {
        dispatchFinished = true;
      });
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));

    const handled = registry.handle(peer, {
      ...fenceOf(peer),
      commandId,
      correlationId: command.correlationId,
      type: "runner.command-accepted",
    });
    await waitFor(() => beforeAck.mock.calls.length === 1);
    expect(dispatchFinished).toBe(false);
    expect(hooks.onCommandAccepted).not.toHaveBeenCalled();

    releaseCommit();
    await handled;
    await dispatch;
    expect(dispatchFinished).toBe(true);
  });

  it("finishes watch reconciliation when the Runner accepts the desired set", async () => {
    const onCommandAccepted = vi.fn(async () => undefined);
    const registry = new RunnerRegistry({
      hooks: {
        authorize: vi.fn(async () => undefined),
        onCommandAccepted,
        onEvent: vi.fn(async () => undefined),
      },
    });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("watch-runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const reconciliation = registry.reconcileWatches(
      environmentId,
      4,
      [],
      new AbortController().signal,
    );
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));
    const sent = peer.messages.findLast((message) => message.type === "host.command");
    if (sent?.type !== "host.command") throw new Error("Expected watch reconciliation command");
    expect(sent.command).toMatchObject({
      desired: [],
      environmentId,
      reconcileGeneration: 4,
      type: "watch.reconcile",
    });
    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: sent.command.commandId,
      correlationId: sent.command.correlationId,
      type: "runner.command-accepted",
    });

    await expect(reconciliation).resolves.toBeUndefined();
    expect(onCommandAccepted).not.toHaveBeenCalled();
  });

  it("survives its Runner disconnecting during an execute's last authority check", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const run = executeCommand(environmentId);

    // Vitest fails the run on an unhandled rejection: the acknowledgement the
    // disconnect rejects must already be observed.
    await expect(
      registry.dispatch(run, new AbortController().signal, {
        beforeSend: async () => {
          registry.disconnect(peer);
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      }),
    ).rejects.toBeDefined();
    expect(
      peer.messages.some(
        (message) => message.type === "host.command" && message.command.commandId === run.commandId,
      ),
    ).toBe(false);
  });

  it("never sends an execute whose Run was stopped during its last authority check", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const run = executeCommand(environmentId);
    const interruptId = createId("command");
    const interrupt = RunnerCommandSchema.parse({
      commandId: interruptId,
      correlationId: CorrelationIdSchema.parse(interruptId),
      environmentId,
      runId: run.context.runId,
      threadId: run.context.threadId,
      type: "run.interrupt",
    });

    // The Stop commits while the execute is still checking its grant: its
    // interrupt reaches the Runner, which holds no such Run and accepts it.
    const dispatched = registry.dispatch(run, new AbortController().signal, {
      beforeSend: async () => {
        const interrupting = registry.dispatch(interrupt, new AbortController().signal);
        await waitFor(() =>
          peer.messages.some(
            (message) =>
              message.type === "host.command" && message.command.commandId === interruptId,
          ),
        );
        await registry.handle(peer, {
          ...fenceOf(peer),
          commandId: interruptId,
          correlationId: interrupt.correlationId,
          type: "runner.command-accepted",
        });
        await interrupting;
      },
    });

    await expect(dispatched).rejects.toMatchObject({
      disposition: "retry",
      message: "Run execution authority was revoked",
    });
    expect(
      peer.messages.some(
        (message) => message.type === "host.command" && message.command.commandId === run.commandId,
      ),
    ).toBe(false);
  });

  it("fences only a concurrent execute while an inactive interrupt is being delivered", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const run = executeCommand(environmentId);
    const trigger = triggerCommand(environmentId);
    const runInterruptId = createId("command");
    const triggerInterruptId = createId("command");

    const runInterrupt = RunnerCommandSchema.parse({
      commandId: runInterruptId,
      correlationId: CorrelationIdSchema.parse(runInterruptId),
      environmentId,
      runId: run.context.runId,
      threadId: run.context.threadId,
      type: "run.interrupt",
    });
    const interruptingRun = registry.dispatch(runInterrupt, new AbortController().signal);
    await waitFor(() =>
      peer.messages.some(
        (message) =>
          message.type === "host.command" && message.command.commandId === runInterruptId,
      ),
    );
    await expect(registry.dispatch(run, new AbortController().signal)).rejects.toMatchObject({
      disposition: "retry",
      message: "Run execution authority was revoked",
    });
    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: runInterruptId,
      correlationId: runInterrupt.correlationId,
      type: "runner.command-accepted",
    });
    await interruptingRun;

    const triggerInterrupt = RunnerCommandSchema.parse({
      commandId: triggerInterruptId,
      correlationId: CorrelationIdSchema.parse(triggerInterruptId),
      environmentId,
      occurrenceId: trigger.context.occurrenceId,
      type: "trigger.interrupt",
    });
    const interruptingTrigger = registry.dispatch(triggerInterrupt, new AbortController().signal);
    await waitFor(() =>
      peer.messages.some(
        (message) =>
          message.type === "host.command" && message.command.commandId === triggerInterruptId,
      ),
    );
    await expect(registry.dispatch(trigger, new AbortController().signal)).rejects.toMatchObject({
      disposition: "failed",
      message: "Trigger execution authority was revoked",
    });
    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: triggerInterruptId,
      correlationId: triggerInterrupt.correlationId,
      type: "runner.command-accepted",
    });
    await interruptingTrigger;

    // Durable Host state forbids a new execute after cancellation. The
    // in-memory fence is deliberately gone once this causal dispatch interval
    // ends; disconnect proves no process-lifetime identifier was retained.
    registry.disconnect(peer);
    await waitFor(() => !registry.isAvailable(environmentId));
    await expect(registry.dispatch(run, new AbortController().signal)).rejects.toMatchObject({
      disposition: "retry",
      message: "Runner is offline",
    });
    await expect(registry.dispatch(trigger, new AbortController().signal)).rejects.toMatchObject({
      disposition: "retry",
      message: "Runner is offline",
    });
  });

  it("releases repeated active cancellation fences at terminal events and disconnect", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
      onTriggerResult: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 1_000 });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const completedRuns: RunnerCommand[] = [];
    const completedTriggers: RunnerCommand[] = [];

    for (let index = 0; index < 3; index += 1) {
      const command = executeCommand(environmentId);
      completedRuns.push(command);
      const executing = registry.dispatch(command, new AbortController().signal);
      await waitFor(() =>
        peer.messages.some(
          (message) =>
            message.type === "host.command" && message.command.commandId === command.commandId,
        ),
      );
      await registry.handle(peer, {
        ...fenceOf(peer),
        commandId: command.commandId,
        correlationId: command.correlationId,
        type: "runner.command-accepted",
      });
      const interruptId = createId("command");
      const interrupt = RunnerCommandSchema.parse({
        commandId: interruptId,
        correlationId: CorrelationIdSchema.parse(interruptId),
        environmentId,
        runId: command.context.runId,
        threadId: command.context.threadId,
        type: "run.interrupt",
      });
      const interrupting = registry.dispatch(interrupt, new AbortController().signal);
      await waitFor(() =>
        peer.messages.some(
          (message) => message.type === "host.command" && message.command.commandId === interruptId,
        ),
      );
      await registry.handle(peer, {
        ...fenceOf(peer),
        commandId: interruptId,
        correlationId: interrupt.correlationId,
        type: "runner.command-accepted",
      });
      await interrupting;
      await registry.handle(peer, {
        ...fenceOf(peer),
        event: {
          bindingGeneration: 1,
          data: { status: "interrupted" },
          emittedAt: new Date().toISOString(),
          environmentId,
          ordinal: 1,
          runId: command.context.runId,
          threadId: command.context.threadId,
          type: "run.interrupted",
          workspaceId: command.context.workspaceId,
        },
        type: "runner.event",
      });
      await executing;
    }

    for (let index = 0; index < 3; index += 1) {
      const command = triggerCommand(environmentId);
      completedTriggers.push(command);
      const executing = registry.dispatch(command, new AbortController().signal);
      await waitFor(() =>
        peer.messages.some(
          (message) =>
            message.type === "host.command" && message.command.commandId === command.commandId,
        ),
      );
      await registry.handle(peer, {
        ...fenceOf(peer),
        commandId: command.commandId,
        correlationId: command.correlationId,
        type: "runner.command-accepted",
      });
      const interruptId = createId("command");
      const interrupt = RunnerCommandSchema.parse({
        commandId: interruptId,
        correlationId: CorrelationIdSchema.parse(interruptId),
        environmentId,
        occurrenceId: command.context.occurrenceId,
        type: "trigger.interrupt",
      });
      const interrupting = registry.dispatch(interrupt, new AbortController().signal);
      await waitFor(() =>
        peer.messages.some(
          (message) => message.type === "host.command" && message.command.commandId === interruptId,
        ),
      );
      await registry.handle(peer, {
        ...fenceOf(peer),
        commandId: interruptId,
        correlationId: interrupt.correlationId,
        type: "runner.command-accepted",
      });
      await interrupting;
      await registry.handle(peer, {
        ...fenceOf(peer),
        environmentId,
        executionGeneration: 1,
        output: {
          completedAt: new Date().toISOString(),
          error: "interrupted",
          exitCode: null,
          occurrenceId: command.context.occurrenceId,
          result: null,
          status: "canceled",
          stderr: "",
          stdout: "",
        },
        type: "runner.trigger-result",
      });
      await executing;
    }

    registry.disconnect(peer);
    await waitFor(() => !registry.isAvailable(environmentId));
    for (const command of completedRuns) {
      const commandId = createId("command");
      await expect(
        registry.dispatch(
          {
            ...command,
            commandId,
            correlationId: CorrelationIdSchema.parse(commandId),
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ disposition: "retry", message: "Runner is offline" });
    }
    for (const command of completedTriggers) {
      const commandId = createId("command");
      await expect(
        registry.dispatch(
          {
            ...command,
            commandId,
            correlationId: CorrelationIdSchema.parse(commandId),
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ disposition: "retry", message: "Runner is offline" });
    }
  });

  it("resolves execution only after the terminal event hook commits", async () => {
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => commit),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 1_000 });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);
    const command = executeCommand(environmentId);
    const controller = new AbortController();
    const dispatched = registry.dispatch(command, controller.signal);
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));
    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: command.commandId,
      correlationId: command.correlationId,
      type: "runner.command-accepted",
    });
    let finished = false;
    void dispatched.then(() => {
      finished = true;
    });
    const terminal = registry.handle(peer, {
      ...fenceOf(peer),
      event: {
        bindingGeneration: 1,
        data: { status: "completed" },
        emittedAt: new Date().toISOString(),
        environmentId,
        ordinal: 1,
        runId: command.context.runId,
        threadId: command.context.threadId,
        type: "run.completed",
        workspaceId: command.context.workspaceId,
      },
      type: "runner.event",
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseCommit();
    await terminal;
    await dispatched;
    expect(finished).toBe(true);
  });

  it("resolves Trigger dispatch only after its result is durably committed", async () => {
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
      onTriggerResult: vi.fn(async () => commit),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 1_000 });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);
    const command = triggerCommand(environmentId);
    const dispatched = registry.dispatch(command, new AbortController().signal);
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));
    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: command.commandId,
      correlationId: command.correlationId,
      type: "runner.command-accepted",
    });
    let finished = false;
    void dispatched.then(() => {
      finished = true;
    });
    const result = registry.handle(peer, {
      ...fenceOf(peer),
      environmentId,
      executionGeneration: 1,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        occurrenceId: command.context.occurrenceId,
        result: { delivered: true },
        status: "succeeded",
        stderr: "",
        stdout: "",
      },
      type: "runner.trigger-result",
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseCommit();
    await result;
    await dispatched;
    expect(hooks.onTriggerResult).toHaveBeenCalledTimes(1);
    expect(finished).toBe(true);
  });

  it("fails closed without sending when the Runner cannot run the command harness", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(
      registry,
      hello(runnerId, environmentId, "boot-1", [
        {
          driverKind: HarnessIdSchema.parse("native"),
          readiness: "unavailable",
          reason: "No model",
        },
      ]),
      peer,
    );
    expect(registry.canRunHarness(environmentId, HarnessIdSchema.parse("native"))).toBe(false);
    await expect(
      registry.dispatch(executeCommand(environmentId), new AbortController().signal),
    ).rejects.toMatchObject({ disposition: "failed" });
    expect(peer.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "host.command" })]),
    );
  });

  it("returns a retry disposition when Runner capacity rejects a command temporarily", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);
    const command = triggerCommand(environmentId);
    const dispatched = registry.dispatch(command, new AbortController().signal);
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));

    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: command.commandId,
      correlationId: command.correlationId,
      error: { code: "conflict", message: "Runner is at its concurrency limit", retryable: true },
      type: "runner.command-rejected",
    });

    await expect(dispatched).rejects.toMatchObject({
      disposition: "retry",
      message: "Runner is at its concurrency limit",
    });
  });

  it("preserves an uncertain steer acknowledgement as unknown delivery", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);
    const command = steerCommand(environmentId);
    const dispatched = registry.dispatch(command, new AbortController().signal);
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));

    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: command.commandId,
      correlationId: command.correlationId,
      message: "Provider acknowledgement was lost",
      type: "runner.command-uncertain",
    });

    await expect(dispatched).rejects.toMatchObject({
      disposition: "uncertain",
      message: "Provider acknowledgement was lost",
    });
  });

  it("rejects an uncertain receipt for a command that is not a steer", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const command = triggerCommand(environmentId);
    const dispatched = registry.dispatch(command, new AbortController().signal);
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));

    await expect(
      registry.handle(peer, {
        ...fenceOf(peer),
        commandId: command.commandId,
        correlationId: command.correlationId,
        message: "Cannot confirm",
        type: "runner.command-uncertain",
      }),
    ).rejects.toThrow("uncertain delivery for trigger.execute");
    await expect(dispatched).rejects.toMatchObject({
      disposition: "failed",
      message: "Runner reported uncertain delivery for trigger.execute",
    });
  });

  it("preserves a proven steer refusal reason", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const command = steerCommand(environmentId);
    const dispatched = registry.dispatch(command, new AbortController().signal);
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));

    await registry.handle(peer, {
      ...fenceOf(peer),
      commandId: command.commandId,
      correlationId: command.correlationId,
      error: { code: "conflict", message: "The active turn already ended", retryable: false },
      type: "runner.command-rejected",
    });

    await expect(dispatched).rejects.toMatchObject({
      disposition: "failed",
      message: "The active turn already ended",
    });
  });

  /*
   * A connection settles the Runs it carried over before it carries new work:
   * - a command sent before the Runner announced its Runs could be confused
   *   with one it carried over, so nothing is dispatched before the answer;
   * - a Run announced for an environment this Runner does not serve is not its
   *   own to report on;
   * - a second announcement on one connection would re-open what was settled;
   * - a resumed Run reports on the new connection, and its terminal event is
   *   acknowledged at once so the Runner can forget it;
   * - capacity counts resumed Runs, so a full Runner is given no more.
   */
  it("settles a connection's Runs before dispatching anything on it", async () => {
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const resumed = executeCommand(environmentId);
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onAttach: vi.fn(async () => [
        { nextOrdinal: 1, runId: resumed.context.runId, status: "attached" as const },
      ]),
      onDisconnect: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks, executionLeaseMs: 60_000 });
    const peer = new MemoryRunnerPeer("runner");
    await registry.register(hello(runnerId, environmentId, "boot-1"), peer);

    await expect(
      registry.dispatch(executeCommand(environmentId), new AbortController().signal),
    ).rejects.toMatchObject({ disposition: "retry" });
    expect(peer.messages.some((message) => message.type === "host.command")).toBe(false);
    expect(registry.isAttached(environmentId)).toBe(false);

    const announced = {
      bindingGeneration: resumed.context.bindingGeneration,
      environmentId,
      nextOrdinal: 1,
      runId: resumed.context.runId,
      terminal: false,
      threadId: resumed.context.threadId,
      workspaceId: resumed.context.workspaceId,
    };
    await registry.handle(peer, {
      ...fenceOf(peer),
      complete: true,
      executions: [announced],
      type: "runner.executions.attach",
    });
    expect(peer.messages.find((message) => message.type === "host.executions.attached")).toEqual(
      expect.objectContaining({
        leaseMs: 60_000,
        results: [{ nextOrdinal: 1, runId: resumed.context.runId, status: "attached" }],
      }),
    );
    expect(registry.isAttached(environmentId)).toBe(true);
    // The resumed Run holds one of the Runner's two places; one more on its
    // way fills it.
    expect(registry.hasRunCapacity(environmentId)).toBe(true);
    expect(registry.hasRunCapacity(environmentId, 1)).toBe(false);

    await registry.handle(peer, {
      ...fenceOf(peer),
      event: {
        bindingGeneration: resumed.context.bindingGeneration,
        data: { status: "completed" },
        emittedAt: new Date().toISOString(),
        environmentId,
        ordinal: 1,
        runId: resumed.context.runId,
        threadId: resumed.context.threadId,
        type: "run.completed",
        workspaceId: resumed.context.workspaceId,
      },
      type: "runner.event",
    });
    await waitFor(() => peer.messages.some((message) => message.type === "host.events.acked"));
    expect(peer.messages.find((message) => message.type === "host.events.acked")).toEqual(
      expect.objectContaining({
        acks: [{ runId: resumed.context.runId, sessionBound: false, throughOrdinal: 1 }],
      }),
    );
    expect(registry.hasRunCapacity(environmentId, 1)).toBe(true);

    await expect(
      registry.handle(peer, {
        ...fenceOf(peer),
        complete: true,
        executions: [],
        type: "runner.executions.attach",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a Run announced for an environment the Runner does not serve", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onAttach: vi.fn(async () => []),
      onDisconnect: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const environmentId = createId("environment");
    const foreign = executeCommand(createId("environment"));
    const peer = new MemoryRunnerPeer("runner");
    await registry.register(hello(createId("runner"), environmentId, "boot-1"), peer);

    await expect(
      registry.handle(peer, {
        ...fenceOf(peer),
        complete: true,
        executions: [
          {
            bindingGeneration: 1,
            environmentId: foreign.environmentId,
            nextOrdinal: 0,
            runId: foreign.context.runId,
            terminal: false,
            threadId: foreign.context.threadId,
            workspaceId: foreign.context.workspaceId,
          },
        ],
        type: "runner.executions.attach",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(hooks.onAttach).not.toHaveBeenCalled();
    expect(registry.isAttached(environmentId)).toBe(false);
  });

  it("retains execution ownership when the acknowledgement is lost", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 5 });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);
    const command = executeCommand(environmentId);

    await expect(registry.dispatch(command, new AbortController().signal)).rejects.toMatchObject({
      disposition: "uncertain",
    });

    await waitFor(() => hooks.onDisconnect.mock.calls.length === 1);
    expect(peer.closed).toMatchObject({ code: 1011 });
    expect(hooks.onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ runnerId }), {
      reason: "lost",
      runIds: [command.context.runId],
      triggerOccurrenceIds: [],
    });
  });

  it("forwards live progress only for a Run this connection was dispatched, under its binding", async () => {
    const onLive = vi.fn();
    const registry = new RunnerRegistry({
      commandAckTimeoutMs: 1_000,
      hooks: {
        authorize: vi.fn(async () => undefined),
        onEvent: vi.fn(async () => undefined),
        onLive,
      },
    });
    const ownerEnvironment = createId("environment");
    const owner = new MemoryRunnerPeer("owner");
    await registerAttached(
      registry,
      hello(createId("runner"), ownerEnvironment, "boot-owner"),
      owner,
    );
    const command = executeCommand(ownerEnvironment);
    void registry.dispatch(command, new AbortController().signal).catch(() => undefined);
    await waitFor(() => owner.messages.some((message) => message.type === "host.command"));
    await registry.handle(owner, {
      ...fenceOf(owner),
      commandId: command.commandId,
      correlationId: command.correlationId,
      type: "runner.command-accepted",
    });
    const { runId, threadId, workspaceId } = command.context;
    const progress = (overrides: { threadId?: typeof threadId } = {}) => ({
      items: [{ at: 0, op: "append" as const, stream: "assistant" as const, text: "Hello" }],
      runId,
      threadId: overrides.threadId ?? threadId,
      workspaceId,
    });

    // Another Runner cannot claim the Run by reporting it in a heartbeat.
    const intruderEnvironment = createId("environment");
    const intruder = new MemoryRunnerPeer("intruder");
    await registerAttached(
      registry,
      hello(createId("runner"), intruderEnvironment, "boot-x"),
      intruder,
    );
    await registry.handle(intruder, {
      ...fenceOf(intruder),
      activeRunIds: [runId],
      activeTriggerOccurrenceIds: [],
      activeWatchActivationIds: [],
      sentAt: new Date().toISOString(),
      type: "runner.heartbeat",
    });
    await registry.handle(intruder, {
      ...fenceOf(intruder),
      bindingGeneration: 1,
      environmentId: intruderEnvironment,
      progress: progress(),
      type: "runner.live",
    });
    // The owner's own frames must match the binding and placement it was sent.
    await registry.handle(owner, {
      ...fenceOf(owner),
      bindingGeneration: 2,
      environmentId: ownerEnvironment,
      progress: progress(),
      type: "runner.live",
    });
    await registry.handle(owner, {
      ...fenceOf(owner),
      bindingGeneration: 1,
      environmentId: ownerEnvironment,
      progress: progress({ threadId: createId("thread") }),
      type: "runner.live",
    });
    expect(onLive).not.toHaveBeenCalled();

    await registry.handle(owner, {
      ...fenceOf(owner),
      bindingGeneration: 1,
      environmentId: ownerEnvironment,
      progress: progress(),
      type: "runner.live",
    });
    expect(onLive).toHaveBeenCalledTimes(1);
  });

  it("replaces heartbeat observations without erasing Host-dispatched ownership", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(
        async (_identity: RunnerIdentity, _scope: RunnerDisconnectScope) => undefined,
      ),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 1_000 });
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const dispatched = executeCommand(environmentId);
    const dispatch = registry.dispatch(dispatched, new AbortController().signal);
    const rejected = expect(dispatch).rejects.toMatchObject({ disposition: "uncertain" });
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));
    const firstObserved = createId("run");
    const latestObserved = createId("run");

    await registry.handle(peer, {
      ...fenceOf(peer),
      activeRunIds: [firstObserved],
      activeTriggerOccurrenceIds: [],
      activeWatchActivationIds: [],
      sentAt: new Date().toISOString(),
      type: "runner.heartbeat",
    });
    await registry.handle(peer, {
      ...fenceOf(peer),
      activeRunIds: [latestObserved],
      activeTriggerOccurrenceIds: [],
      activeWatchActivationIds: [],
      // Heartbeat timestamps must advance, or a replayed one would renew a
      // lease on behalf of a Runner that stopped answering.
      sentAt: new Date(Date.now() + 1_000).toISOString(),
      type: "runner.heartbeat",
    });
    registry.disconnect(peer);

    await waitFor(() => hooks.onDisconnect.mock.calls.length === 1);
    expect(hooks.onDisconnect.mock.calls[0]?.[1]).toEqual({
      reason: "lost",
      runIds: [dispatched.context.runId, latestObserved],
      triggerOccurrenceIds: [],
    });
    expect(hooks.onDisconnect.mock.calls[0]?.[1]?.runIds).not.toContain(firstObserved);
    await rejected;
  });

  it("retries disconnect recovery without losing the exact ownership scope", async () => {
    const environmentId = createId("environment");
    const command = executeCommand(environmentId);
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi
        .fn<(_identity: RunnerIdentity, scope: RunnerDisconnectScope) => Promise<void>>()
        .mockRejectedValueOnce(new Error("database temporarily unavailable"))
        .mockResolvedValue(undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 1_000 });
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
    const dispatch = registry.dispatch(command, new AbortController().signal);
    const rejected = expect(dispatch).rejects.toMatchObject({ disposition: "uncertain" });
    await waitFor(() => peer.messages.some((message) => message.type === "host.command"));

    registry.disconnect(peer);
    await vi.waitFor(() => expect(hooks.onDisconnect).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(hooks.onDisconnect.mock.calls[0]?.[1]).toEqual({
      reason: "lost",
      runIds: [command.context.runId],
      triggerOccurrenceIds: [],
    });
    expect(hooks.onDisconnect.mock.calls[1]?.[1]).toEqual(hooks.onDisconnect.mock.calls[0]?.[1]);
    await rejected;
  });

  it("drains a disconnect hook already running when close begins", async () => {
    let finishRecovery!: () => void;
    const hook = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("temporary recovery failure"))
        .mockImplementation(async () => hook),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);

    registry.disconnect(peer);
    await vi.waitFor(() => expect(hooks.onDisconnect).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    const closing = registry.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    finishRecovery();
    await expect(closing).resolves.toBeUndefined();
    expect(hooks.onDisconnect).toHaveBeenCalledTimes(2);
    registry.disconnect(peer);
    await Promise.resolve();
    expect(hooks.onDisconnect).toHaveBeenCalledTimes(2);
  });

  it("scopes delayed disconnect recovery to work owned by the old connection", async () => {
    let releaseFirstDisconnect!: () => void;
    const firstDisconnect = new Promise<void>((resolve) => {
      releaseFirstDisconnect = resolve;
    });
    let disconnectCount = 0;
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(async (_identity: RunnerIdentity, _scope: RunnerDisconnectScope) => {
        disconnectCount += 1;
        if (disconnectCount === 1) await firstDisconnect;
      }),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks, commandAckTimeoutMs: 1_000 });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const firstPeer = new MemoryRunnerPeer("first");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), firstPeer);

    const firstCommand = executeCommand(environmentId);
    const firstDispatch = registry.dispatch(firstCommand, new AbortController().signal);
    const firstRejected = expect(firstDispatch).rejects.toMatchObject({ disposition: "uncertain" });
    await waitFor(() => firstPeer.messages.some((message) => message.type === "host.command"));
    registry.disconnect(firstPeer);
    await waitFor(() => hooks.onDisconnect.mock.calls.length === 1);
    await firstRejected;

    const secondPeer = new MemoryRunnerPeer("second");
    const secondIdentity = {
      ...hello(runnerId, environmentId, "boot-1"),
      connectionGeneration: 2,
      connectionId: "rcn_00000000-0000-4000-8000-000000000002" as RunnerIdentity["connectionId"],
    };
    await registerAttached(registry, secondIdentity, secondPeer);
    const secondCommand = executeCommand(environmentId);
    const secondController = new AbortController();
    const secondDispatch = registry.dispatch(secondCommand, secondController.signal);
    const secondRejected = expect(secondDispatch).rejects.toMatchObject({
      disposition: "uncertain",
    });
    await waitFor(() => secondPeer.messages.some((message) => message.type === "host.command"));

    expect(hooks.onDisconnect.mock.calls[0]).toEqual([
      expect.objectContaining({ connectionGeneration: 1, runnerId }),
      { reason: "lost", runIds: [firstCommand.context.runId], triggerOccurrenceIds: [] },
    ]);
    expect(hooks.onDisconnect.mock.calls[0]?.[1]?.runIds).not.toContain(
      secondCommand.context.runId,
    );

    secondController.abort(new Error("test complete"));
    await secondRejected;
    releaseFirstDisconnect();
    await registry.close();
  });

  it("rolls registration back when the welcome cannot be delivered", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new RejectingRunnerPeer("runner");

    await expect(registry.register(hello(runnerId, environmentId, "boot-1"), peer)).rejects.toThrow(
      "welcome failed",
    );
    expect(registry.isAvailable(environmentId)).toBe(false);
    expect(registry.identityForEnvironment(environmentId)).toBeUndefined();
    expect(peer.closed).toMatchObject({ code: 1011 });
    expect(hooks.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("does not complete registration after the peer disconnects during welcome", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    let peer!: MemoryRunnerPeer;
    peer = new MemoryRunnerPeer("runner", () => registry.disconnect(peer));

    await expect(registry.register(hello(runnerId, environmentId, "boot-1"), peer)).rejects.toThrow(
      "disconnected before registration completed",
    );
    expect(registry.isAvailable(environmentId)).toBe(false);
    expect(hooks.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("announces a registration only once the Runner is reachable", async () => {
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    const available: Record<string, boolean> = {};
    let welcomed = false;
    let registry!: RunnerRegistry;
    const hooks = {
      authorize: vi.fn(async () => {
        available.authorize = registry.isAvailable(environmentId);
      }),
      onEvent: vi.fn(async () => undefined),
      onRegistered: vi.fn(async () => {
        available.registered = registry.isAvailable(environmentId);
        welcomed = peer.messages.some((message) => message.type === "host.welcome");
      }),
    };
    registry = new RunnerRegistry({ hooks });

    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);
    await waitFor(() => hooks.onRegistered.mock.calls.length === 1);

    expect(available).toEqual({ authorize: false, registered: true });
    expect(welcomed).toBe(true);
    expect(hooks.onRegistered).toHaveBeenCalledWith(
      expect.objectContaining({ bootId: "boot-1", runnerId }),
    );
    await registry.close();
  });

  it("keeps a Runner connected when its registration hook fails", async () => {
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
      onRegistered: vi.fn(async () => {
        throw new Error("Harness catalog capture failed");
      }),
    };
    const registry = new RunnerRegistry({ hooks });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");

    await expect(
      registry.register(hello(runnerId, environmentId, "boot-1"), peer),
    ).resolves.toMatchObject({ bootId: "boot-1" });
    await waitFor(() => hooks.onRegistered.mock.calls.length === 1);

    expect(registry.isAvailable(environmentId)).toBe(true);
    expect(peer.closed).toBeUndefined();
    await registry.close();
  });

  describe("harness catalogs", () => {
    /** One profile definition, shaped exactly as both catalog messages carry it. */
    function definition(id: ReturnType<typeof createId<"harnessInstance">>) {
      return {
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        id,
        name: "Opensteer",
        runtimeRevision: 1,
        sourceId: "native",
        stateKind: "isolated",
      } as const;
    }

    async function attached(
      onHarnessCatalogInvalidated?: RunnerRegistryHooks["onHarnessCatalogInvalidated"],
    ) {
      const hooks = {
        authorize: vi.fn(async () => undefined),
        onEvent: vi.fn(async () => undefined),
        ...(onHarnessCatalogInvalidated ? { onHarnessCatalogInvalidated } : {}),
      };
      const registry = new RunnerRegistry({ hooks });
      const environmentId = createId("environment");
      const peer = new MemoryRunnerPeer("runner");
      await registerAttached(registry, hello(createId("runner"), environmentId, "boot-1"), peer);
      // The handshake's welcome shares the peer's message log, so catalog
      // traffic is read on its own rather than by absolute position.
      const catalogs = () =>
        peer.messages.filter(
          (message) =>
            message.type === "host.inspect-harnesses" ||
            message.type === "host.reconcile-harnesses",
        );
      const answer = async (
        index: number,
        status: "authentication-required" | "preparing" | "ready" = "ready",
        modelId = "gpt-5.6-sol",
      ) => {
        const request = catalogs()[index];
        if (!request) throw new Error("No catalog request was sent");
        await registry.handle(peer, {
          ...fenceOf(peer),
          catalogs: request.harnesses.map((harness) =>
            HarnessInstanceCatalogSchema.parse(
              status !== "ready"
                ? {
                    connections: [],
                    detail: `Preparing ${harness.name}…`,
                    driverKind: harness.driverKind,
                    harnessInstanceId: harness.id,
                    models: [],
                    setupMethods: [],
                    status,
                  }
                : {
                    connections: [],
                    continuationIdentity: {
                      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
                      driverKind: harness.driverKind,
                    },
                    driverKind: harness.driverKind,
                    harnessInstanceId: harness.id,
                    models: [
                      {
                        displayName: modelId,
                        isDefault: true,
                        modelId,
                        options: [],
                        providerId: "openai",
                      },
                    ],
                    setupMethods: [],
                    status,
                    steering: false,
                  },
            ),
          ),
          requestId: request.requestId,
          type: "runner.harness-catalog",
        });
      };
      return { answer, catalogs, environmentId, peer, registry };
    }

    it("collapses concurrent identical inspections into one round trip", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const harnesses = [definition(createId("harnessInstance"))];
      const signal = new AbortController().signal;

      const first = registry.inspectHarnesses(environmentId, harnesses, signal);
      const second = registry.inspectHarnesses(environmentId, harnesses, signal);
      await waitFor(() => catalogs().length === 1);
      expect(catalogs()[0]?.type).toBe("host.inspect-harnesses");

      await answer(0);
      expect(await first).toEqual(await second);
      // And the cached answer is served without entering any queue at all.
      expect(await registry.inspectHarnesses(environmentId, harnesses, signal)).toHaveLength(1);
      expect(catalogs()).toHaveLength(1);
      await registry.close();
    });

    it("keeps sign-in required across cache expiry but refreshes on request and profile changes", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const harness = definition(createId("harnessInstance"));
      const signal = new AbortController().signal;
      try {
        const first = registry.inspectHarnesses(environmentId, [harness], signal);
        await waitFor(() => catalogs().length === 1);
        await answer(0, "authentication-required");
        await first;
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
        try {
          await expect(
            registry.inspectHarnesses(environmentId, [harness], signal),
          ).resolves.toMatchObject([{ status: "authentication-required" }]);
          expect(catalogs()).toHaveLength(1);
        } finally {
          clock.mockRestore();
        }
        const refresh = registry.inspectHarnesses(environmentId, [harness], signal, {
          fresh: true,
        });
        await waitFor(() => catalogs().length === 2);
        await answer(1, "authentication-required");
        await refresh;
        const changed = registry.inspectHarnesses(
          environmentId,
          [{ ...harness, runtimeRevision: 2 }],
          signal,
        );
        await waitFor(() => catalogs().length === 3);
        await answer(2);
        await expect(changed).resolves.toMatchObject([{ status: "ready" }]);
      } finally {
        await registry.close();
      }
    });

    it("fans a multi-profile inspection into bounded per-profile requests", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const harnesses = [
        definition(createId("harnessInstance")),
        definition(createId("harnessInstance")),
      ];
      const inspection = registry.inspectHarnesses(
        environmentId,
        harnesses,
        new AbortController().signal,
      );
      await waitFor(() => catalogs().length === 2);
      expect(catalogs().map((request) => request.harnesses.map((harness) => harness.id))).toEqual([
        [harnesses[0]?.id],
        [harnesses[1]?.id],
      ]);
      await answer(1, "ready", "model-two");
      await answer(0, "ready", "model-one");
      expect((await inspection).map((catalog) => catalog.models[0]?.modelId)).toEqual([
        "model-one",
        "model-two",
      ]);
      await registry.close();
    });

    it("does not let an older batch response overwrite a newer profile result", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const first = definition(createId("harnessInstance"));
      const second = definition(createId("harnessInstance"));
      const signal = new AbortController().signal;
      const reconciliation = registry.reconcileHarnesses(environmentId, [first, second], signal);
      await waitFor(() => catalogs().length === 1);
      const refresh = registry.inspectHarnesses(environmentId, [first], signal, { fresh: true });
      await waitFor(() => catalogs().length === 2);

      await answer(1, "ready", "new-model");
      await expect(refresh).resolves.toMatchObject([
        { models: [expect.objectContaining({ modelId: "new-model" })] },
      ]);
      await answer(0, "ready", "old-model");
      const reconciled = await reconciliation;
      expect(reconciled[0]?.models[0]?.modelId).toBe("new-model");
      expect(reconciled[1]?.models[0]?.modelId).toBe("old-model");
      expect(registry.catalogForHarness(environmentId, first.id)?.models[0]?.modelId).toBe(
        "new-model",
      );
      await registry.close();
    });

    it("does not reuse a cached catalog after the profile definition changes", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const harness = definition(createId("harnessInstance"));
      const signal = new AbortController().signal;
      const initial = registry.inspectHarnesses(environmentId, [harness], signal);
      await waitFor(() => catalogs().length === 1);
      await answer(0);
      await initial;

      const changed = { ...harness, sourceId: "another-source" };
      const refreshed = registry.inspectHarnesses(environmentId, [changed], signal);
      await waitFor(() => catalogs().length === 2);
      await answer(1, "ready", "changed-model");
      await expect(refreshed).resolves.toMatchObject([
        { models: [expect.objectContaining({ modelId: "changed-model" })] },
      ]);
      await registry.close();
    });

    it("bypasses a cached catalog for explicit refresh while coalescing concurrent refreshes", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const harnesses = [definition(createId("harnessInstance"))];
      const signal = new AbortController().signal;
      try {
        const initial = registry.inspectHarnesses(environmentId, harnesses, signal);
        await waitFor(() => catalogs().length === 1);
        await answer(0);
        await initial;
        const first = registry.inspectHarnesses(environmentId, harnesses, signal, { fresh: true });
        const second = registry.inspectHarnesses(environmentId, harnesses, signal, { fresh: true });
        await waitFor(() => catalogs().length === 2);
        await answer(1);
        expect(await first).toEqual(await second);
        expect(catalogs()).toHaveLength(2);
      } finally {
        await registry.close();
      }
    });

    it("starts an independent recapture when native preparation invalidates an older answer", async () => {
      let registry!: RunnerRegistry;
      let environmentId!: ReturnType<typeof createId<"environment">>;
      let harnesses!: ReturnType<typeof definition>[];
      let recapture: ReturnType<RunnerRegistry["inspectHarnesses"]> | undefined;
      const invalidated = vi.fn(async () => {
        recapture = registry.inspectHarnesses(
          environmentId,
          harnesses,
          new AbortController().signal,
        );
        await recapture;
      });
      const connection = await attached(invalidated);
      registry = connection.registry;
      environmentId = connection.environmentId;
      const harnessInstanceId = createId("harnessInstance");
      harnesses = [definition(harnessInstanceId)];

      const initial = registry.inspectHarnesses(
        environmentId,
        harnesses,
        new AbortController().signal,
      );
      await waitFor(() => connection.catalogs().length === 1);
      await registry.handle(connection.peer, {
        ...fenceOf(connection.peer),
        harnessInstanceId,
        type: "runner.harness-catalog-invalidated",
      });

      await waitFor(() => connection.catalogs().length === 2);
      expect(invalidated).toHaveBeenCalledWith(
        expect.objectContaining({ environmentIds: [environmentId] }),
        expect.objectContaining({ harnessInstanceId, type: "runner.harness-catalog-invalidated" }),
      );
      expect(connection.catalogs()[1]?.type).toBe("host.inspect-harnesses");

      // The request sent before invalidation may still settle afterward, but
      // its obsolete answer must not reach a caller that could persist it.
      await connection.answer(0, "preparing");
      await expect(initial).rejects.toMatchObject({ code: "conflict", retryable: true });
      await connection.answer(1, "ready");
      await expect(recapture).resolves.toMatchObject([{ status: "ready" }]);
      expect(registry.catalogForHarness(environmentId, harnessInstanceId)).toMatchObject({
        status: "ready",
      });
      await expect(
        registry.inspectHarnesses(environmentId, harnesses, new AbortController().signal),
      ).resolves.toMatchObject([{ status: "ready" }]);
      expect(connection.catalogs()).toHaveLength(2);
      await registry.close();
    });

    it("cancels one catalog waiter without canceling connection-owned startup", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const harnesses = [definition(createId("harnessInstance"))];
      const abandoned = new AbortController();
      const first = registry.inspectHarnesses(environmentId, harnesses, abandoned.signal);
      await waitFor(() => catalogs().length === 1);

      abandoned.abort(new Error("Settings view closed"));
      await expect(first).rejects.toThrow("Settings view closed");
      const joined = registry.inspectHarnesses(
        environmentId,
        harnesses,
        new AbortController().signal,
      );
      expect(catalogs()).toHaveLength(1);

      await answer(0);
      await expect(joined).resolves.toHaveLength(1);
      await registry.close();
    });

    it("settles connection-owned catalog startup when the registry closes", async () => {
      const { catalogs, environmentId, registry } = await attached();
      const inspecting = registry.inspectHarnesses(
        environmentId,
        [definition(createId("harnessInstance"))],
        new AbortController().signal,
      );
      await waitFor(() => catalogs().length === 1);

      const closing = registry.close();
      await expect(inspecting).rejects.toThrow(/shutting down|closing/u);
      await closing;
    });

    it("lets an inspection overtake a reconciliation that is still in flight", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const signal = new AbortController().signal;
      const reconciling = registry.reconcileHarnesses(
        environmentId,
        [definition(createId("harnessInstance"))],
        signal,
      );
      await waitFor(() => catalogs().length === 1);
      expect(catalogs()[0]?.type).toBe("host.reconcile-harnesses");

      // A different set, so it cannot join the in-flight request. It must still
      // reach the wire while the reconciliation is unanswered.
      const inspecting = registry.inspectHarnesses(
        environmentId,
        [definition(createId("harnessInstance"))],
        signal,
      );
      await waitFor(() => catalogs().length === 2);
      expect(catalogs()[1]?.type).toBe("host.inspect-harnesses");

      await answer(1);
      await expect(inspecting).resolves.toHaveLength(1);
      await answer(0);
      await expect(reconciling).resolves.toHaveLength(1);
      await registry.close();
    });

    it("orders reconciliations and releases the queue when a waiter gives up", async () => {
      const { answer, catalogs, environmentId, registry } = await attached();
      const first = registry.reconcileHarnesses(
        environmentId,
        [definition(createId("harnessInstance"))],
        new AbortController().signal,
      );
      await waitFor(() => catalogs().length === 1);

      // The second reconciliation is still queued behind the first, so nothing
      // it does may reach the Runner — and abandoning it must not wedge the
      // queue for whoever comes next.
      const abandoned = new AbortController();
      const second = registry.reconcileHarnesses(
        environmentId,
        [definition(createId("harnessInstance"))],
        abandoned.signal,
      );
      abandoned.abort(new Error("Caller gave up"));
      await expect(second).rejects.toThrow(/gave up/u);
      expect(catalogs()).toHaveLength(1);

      await answer(0);
      await expect(first).resolves.toHaveLength(1);

      const third = registry.reconcileHarnesses(
        environmentId,
        [definition(createId("harnessInstance"))],
        new AbortController().signal,
      );
      await waitFor(() => catalogs().length === 2);
      await answer(1);
      await expect(third).resolves.toHaveLength(1);
      await registry.close();
    });
  });
});

class MemoryRunnerPeer implements RunnerPeer {
  readonly id: string;
  readonly messages: HostToRunnerMessage[] = [];
  closed: { code: number; reason: string } | undefined;
  readonly #onSend: (() => void) | undefined;
  constructor(id: string, onSend?: () => void) {
    this.id = id;
    this.#onSend = onSend;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  async send(message: HostToRunnerMessage): Promise<void> {
    this.messages.push(message);
    this.#onSend?.();
  }
}

class RejectingRunnerPeer implements RunnerPeer {
  readonly id: string;
  closed: { code: number; reason: string } | undefined;

  constructor(id: string) {
    this.id = id;
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  send(_message: HostToRunnerMessage): Promise<void> {
    return Promise.reject(new Error("welcome failed"));
  }
}

type AgentHarnessDrivers = NonNullable<RunnerIdentity["modules"]["agents"]>["harnessDrivers"];

/** One minimal first-party source, shaped exactly as a driver declares it. */
function harnessSources(sourceId: string, label: string): HarnessSourceDescriptor[] {
  return [
    {
      fields: [],
      kind: "first-party",
      label,
      quota: "none",
      sourceId,
      stateKinds: ["ambient", "isolated"],
    },
  ];
}

function hello(
  runnerId: ReturnType<typeof createId<"runner">>,
  environmentId: ReturnType<typeof createId<"environment">>,
  bootId: string,
  harnessDrivers: AgentHarnessDrivers = [
    {
      accessModes: ThreadAccessModeSchema.options,
      driverKind: HarnessIdSchema.parse("native"),
      readiness: "configured",
      steering: false,
      sources: harnessSources("native", "Native"),
    },
  ],
): RunnerIdentity {
  const generation = bootId.endsWith("2") ? 2 : 1;
  const fence: RunnerConnectionFence = {
    bootId: bootId as RunnerIdentity["bootId"],
    connectionGeneration: generation,
    connectionId:
      `rcn_00000000-0000-4000-8000-00000000000${generation}` as RunnerIdentity["connectionId"],
    connectionLeaseId:
      `rls_00000000-0000-4000-8000-00000000000${generation}` as RunnerIdentity["connectionLeaseId"],
    runnerId,
  };
  return {
    ...fence,
    allowedModules: ["agents"],
    capabilities: ["filesystem"],
    personalRemoteAccessGeneration: null,
    environmentIds: [environmentId],
    fence,
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers,
        localStorage: null,
        maxConcurrentRuns: 2,
        providerStateModes: ["isolated"],
        workspaceBackings: ["portablefs"],
        workspaceMounts: [],
      },
    },
    name: "Runner",
    runnerKind: "main",
    runtimeVersion: "test",
  };
}

/**
 * The fence the Host handed this peer in its welcome. Tests repeat it on every
 * frame because the Runner has to.
 */
/** Registers a connection that holds no Runs and says so, as every Runner does first. */
async function registerAttached(
  registry: RunnerRegistry,
  identity: Parameters<RunnerRegistry["register"]>[0],
  peer: MemoryRunnerPeer,
): Promise<Awaited<ReturnType<RunnerRegistry["register"]>>> {
  const registered = await registry.register(identity, peer);
  await registry.handle(peer, {
    ...fenceOf(peer),
    complete: true,
    executions: [],
    type: "runner.executions.attach",
  });
  return registered;
}

function fenceOf(peer: MemoryRunnerPeer): RunnerConnectionFence {
  const welcome = peer.messages.find((message) => message.type === "host.welcome");
  if (!welcome) throw new Error("The peer was never welcomed");
  return {
    bootId: welcome.bootId,
    connectionGeneration: welcome.connectionGeneration,
    connectionId: welcome.connectionId,
    connectionLeaseId: welcome.connectionLeaseId,
    runnerId: welcome.runnerId,
  };
}

function executeCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
): RunnerCommand & {
  type: "run.execute";
} {
  const commandId = createId("command");
  const workspaceId = createId("workspace");
  return {
    commandId,
    context: {
      accessMode: "full-access",
      assignment: null,
      agentControl: {
        token: "agent-token",
        url: "https://host.example.test/internal/v1/agent-control",
      },
      agentTools: {
        capabilityProfileId: "workspace",
        token: "agent-tools-token",
        url: "https://host.example.test/internal/v1/mcp",
      },
      browserCdp: {
        token: "browser-cdp-token",
        url: "https://host.example.test/internal/v1/browser-cdp",
      },
      integrationTools: {
        token: "agent-tools-token",
        url: "https://host.example.test/internal/v1/integration-mcp",
      },
      integrationSkills: {
        token: "integration-skills-token",
        url: "https://host.example/internal/v1/integration-skills",
      },
      bindingGeneration: 1,
      executionLeaseMs: 90_000,
      membershipGeneration: 1,
      egress: {
        maxRequestBytes: 1_024,
        maxResponseBytes: 2_048,
        relayToken: "token",
        relayUrl: "https://host.example.test/internal/v1/egress",
      },
      environmentId,
      harness: {
        config: { model: "test" },
        driverKind: HarnessIdSchema.parse("native"),
        name: "Native",
        runtimeRevision: 1,
        sourceId: "native",
        stateKind: "isolated",
      },
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: { effort: "low" },
        providerId: "openai",
      }),
      harnessInstanceId: createId("harnessInstance"),
      history: [],
      historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
      initialContext: null,
      providerSessionId: createId("providerSession"),
      providerSessionReference: null,
      providerSessionStateLayout: "session",
      requestedBy: createId("user"),
      requesterTimeZone: null,
      runId: createId("run"),
      threadId: createId("thread"),
      threadRole: "work",
      threadState: { previousAssignment: null, previousRun: null },
      workspaceId,
      workspaceKind: "specialized",
      machineAccess: { callerMachineName: "Alex's Mac", machines: [], omittedMachines: 0 },
      workspaceInstructionsPath: "AGENTS.md",
      workspaceAccess: {
        createdBy: createId("user"),
        exchangeToken: "token",
        exchangeUrl: "https://host.example.test/internal/v1/mount-grants/exchange",
        generation: 1,
        kind: "portablefs",
        volumeId: "volume-1",
        workspaceId,
        workspaceKind: "specialized",
      },
    },
    correlationId: CorrelationIdSchema.parse(commandId),
    environmentId,
    inputs: [
      {
        author: {
          displayName: "Test user",
          kind: "human",
          principalId: "pri_00000000-0000-4000-8000-000000000099",
          userId: createId("user"),
        },
        content: [{ text: "hello", type: "text" }],
        createdAt: new Date().toISOString(),
        kind: "input",
        messageId: createId("message"),
      },
    ],
    reports: { messages: [], omittedCount: 0, throughSequence: null },
    type: "run.execute",
  };
}

function steerCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
): RunnerCommand & { type: "run.steer" } {
  const commandId = createId("command");
  return RunnerCommandSchema.parse({
    commandId,
    correlationId: CorrelationIdSchema.parse(commandId),
    environmentId,
    input: {
      author: { displayName: "User", kind: "human", principalId: "principal:test" },
      content: [{ text: "Steer this run", type: "text" }],
      createdAt: new Date().toISOString(),
      kind: "input",
      messageId: createId("message"),
    },
    runId: createId("run"),
    threadId: createId("thread"),
    type: "run.steer",
  }) as RunnerCommand & { type: "run.steer" };
}

function triggerCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
): Extract<RunnerCommand, { type: "trigger.execute" }> {
  const anchorThreadId = createId("thread");
  const occurrenceId = createId("triggerOccurrence");
  const revisionId = createId("triggerRevision");
  const triggerId = createId("trigger");
  const workspaceId = createId("workspace");
  return RunnerCommandSchema.parse({
    commandId: createId("command"),
    context: {
      anchorThreadId,
      browserCdp: null,
      event: {
        id: occurrenceId,
        payload: null,
        receivedAt: new Date().toISOString(),
        source: { kind: "manual" },
        trigger: { anchorThreadId, id: triggerId, revisionId, workspaceId },
      },
      executionGeneration: 1,
      integrationMcp: {
        token: "integration-mcp-token",
        url: "https://host.example.test/internal/v1/integration-mcp",
      },
      mcp: { token: "mcp-token", url: "https://host.example.test/internal/v1/mcp" },
      occurrenceId,
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      revisionId,
      triggerId,
      workspaceId,
      workspaceAccess: {
        createdBy: createId("user"),
        exchangeToken: "token",
        exchangeUrl: "https://host.example.test/internal/v1/mount-grants/exchange",
        generation: 1,
        kind: "portablefs",
        volumeId: "volume-1",
        workspaceId,
        workspaceKind: "specialized",
      },
    },
    correlationId: CorrelationIdSchema.parse("trigger-dispatch-test"),
    environmentId,
    type: "trigger.execute",
  }) as Extract<RunnerCommand, { type: "trigger.execute" }>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}

describe("MCP image rendering", () => {
  const selection = ModelSelectionSchema.parse({
    modelId: "gpt-5.6-sol",
    options: {},
    providerId: "openai",
  });

  /**
   * One attached Runner that has reported one account's catalog, so the gate
   * reads exactly what a Runner advertised about the engine and the model.
   */
  async function reported(options: {
    readonly acceptsImages?: boolean;
    readonly mcpImageContent?: boolean;
    readonly report?: boolean;
  }) {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const environmentId = createId("environment");
    const driverKind = HarnessIdSchema.parse("native");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(
      registry,
      hello(createId("runner"), environmentId, "boot-1", [
        {
          accessModes: ThreadAccessModeSchema.options,
          driverKind,
          ...(options.mcpImageContent === undefined
            ? {}
            : { mcpImageContent: options.mcpImageContent }),
          readiness: "configured",
          sources: harnessSources("native", "Native"),
          steering: false,
        },
      ]),
      peer,
    );
    const harnessInstanceId = createId("harnessInstance");
    if (options.report !== false) {
      const inspection = registry.inspectHarnesses(
        environmentId,
        [
          {
            config: {},
            driverKind,
            id: harnessInstanceId,
            name: "Opensteer",
            runtimeRevision: 1,
            sourceId: "native",
            stateKind: "isolated",
          },
        ],
        new AbortController().signal,
      );
      await waitFor(() =>
        peer.messages.some((message) => message.type === "host.inspect-harnesses"),
      );
      const request = peer.messages.find((message) => message.type === "host.inspect-harnesses");
      if (request?.type !== "host.inspect-harnesses") throw new Error("No inspection was sent");
      await registry.handle(peer, {
        ...fenceOf(peer),
        catalogs: [
          HarnessInstanceCatalogSchema.parse({
            connections: [],
            continuationIdentity: {
              continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
              driverKind,
            },
            driverKind,
            harnessInstanceId,
            models: [
              {
                ...(options.acceptsImages === undefined
                  ? {}
                  : { acceptsImages: options.acceptsImages }),
                displayName: "GPT-5.6 Sol",
                isDefault: true,
                modelId: selection.modelId,
                options: [],
                providerId: selection.providerId,
              },
            ],
            setupMethods: [],
            status: "ready",
            steering: false,
          }),
        ],
        requestId: request.requestId,
        type: "runner.harness-catalog",
      });
      await inspection;
    }
    const renders = registry.rendersMcpImagesForModel({
      driverKind,
      environmentId,
      harnessInstanceId,
      modelSelection: selection,
    });
    await registry.close();
    return renders;
  }

  it("sends the picture only when the engine renders it and the model reads it", async () => {
    await expect(reported({ acceptsImages: true, mcpImageContent: true })).resolves.toBe(true);
  });

  it("holds the picture back when the model does not read images", async () => {
    await expect(reported({ acceptsImages: false, mcpImageContent: true })).resolves.toBe(false);
  });

  it("holds the picture back when the engine does not render one", async () => {
    await expect(reported({ acceptsImages: true, mcpImageContent: false })).resolves.toBe(false);
    await expect(reported({ acceptsImages: false, mcpImageContent: false })).resolves.toBe(false);
    // An older Runner says nothing about the capability at all.
    await expect(reported({ acceptsImages: true })).resolves.toBe(false);
  });

  it("treats a model that says nothing, and an account with no catalog, as no images", async () => {
    await expect(reported({ mcpImageContent: true })).resolves.toBe(false);
    await expect(
      reported({ acceptsImages: true, mcpImageContent: true, report: false }),
    ).resolves.toBe(false);
  });
});

describe("Runner connection fences and leases", () => {
  it("refuses a frame written for a superseded connection", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, environmentId, "boot-1"), peer);
    const current = fenceOf(peer);

    await expect(
      registry.handle(peer, {
        ...current,
        activeRunIds: [],
        activeTriggerOccurrenceIds: [],
        activeWatchActivationIds: [],
        connectionGeneration: current.connectionGeneration + 1,
        sentAt: new Date().toISOString(),
        type: "runner.heartbeat",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("closes a socket that stops answering even while it stays open", async () => {
    let now = 1_000;
    const hooks = {
      authorize: vi.fn(async () => undefined),
      onDisconnect: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
    };
    const registry = new RunnerRegistry({
      connectionLeaseMs: 50,
      hooks,
      now: () => now,
    });
    const runnerId = createId("runner");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, hello(runnerId, createId("environment"), "boot-1"), peer);
    expect(registry.isRunnerConnected(runnerId)).toBe(true);

    now += 51;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(peer.closed).toMatchObject({ code: 4003 });
    expect(registry.isRunnerConnected(runnerId)).toBe(false);
  });

  it("keeps a module unroutable until it reports readiness for itself", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, browserRunner(runnerId, "boot-1"), peer);

    // A live socket is connection authority, never module readiness.
    expect(registry.runnersForModule("browser")).toEqual([]);
    await registry.handle(peer, {
      ...fenceOf(peer),
      activeRunIds: [],
      activeTriggerOccurrenceIds: [],
      activeWatchActivationIds: [],
      sentAt: new Date().toISOString(),
      type: "runner.heartbeat",
    });
    expect(registry.runnersForModule("browser")).toEqual([]);

    await registry.handle(peer, {
      ...fenceOf(peer),
      modules: [
        {
          checkedAt: new Date().toISOString(),
          detail: null,
          module: "browser",
          readiness: "ready",
        },
      ],
      type: "runner.modules.report",
    });
    expect(registry.runnersForModule("browser").map((identity) => identity.runnerId)).toEqual([
      runnerId,
    ]);

    // Losing a module drops it from routing at once, and leaves the machine's
    // other work — and its connection generation — alone.
    await registry.handle(peer, {
      ...fenceOf(peer),
      modules: [
        {
          checkedAt: new Date().toISOString(),
          detail: "Chromium exited",
          module: "browser",
          readiness: "unavailable",
        },
      ],
      type: "runner.modules.report",
    });
    expect(registry.runnersForModule("browser")).toEqual([]);
    expect(registry.isRunnerConnected(runnerId)).toBe(true);
    expect(registry.moduleReadiness(runnerId, "browser")).toBe("unavailable");
    expect(environmentId).toBeDefined();
  });

  it("refuses readiness for a module the Runner never advertised", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, browserRunner(createId("runner"), "boot-1"), peer);

    await expect(
      registry.handle(peer, {
        ...fenceOf(peer),
        modules: [
          {
            checkedAt: new Date().toISOString(),
            detail: null,
            module: "messaging",
            readiness: "ready",
          },
        ],
        type: "runner.modules.report",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("Runner auxiliary streams", () => {
  it("refuses a ticket minted for a primary connection that has been replaced", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const runnerId = createId("runner");
    const first = new MemoryRunnerPeer("first");
    await registerAttached(registry, browserRunner(runnerId, "boot-1"), first);
    const stale = ticket(fenceOf(first));
    await registerAttached(
      registry,
      browserRunner(runnerId, "boot-2"),
      new MemoryRunnerPeer("second"),
    );

    expect(() =>
      registry.admitAuxiliary({
        claims: stale,
        module: "browser",
        peer: new MemoryAuxiliaryPeer("browser"),
      }),
    ).toThrow(/superseded primary connection/u);
  });

  it("refuses a ticket presented on the wrong module's route", async () => {
    const registry = new RunnerRegistry({
      hooks: { authorize: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) },
    });
    const peer = new MemoryRunnerPeer("runner");
    await registerAttached(registry, browserRunner(createId("runner"), "boot-1"), peer);

    expect(() =>
      registry.admitAuxiliary({
        claims: ticket(fenceOf(peer)),
        module: "messaging",
        peer: new MemoryAuxiliaryPeer("messaging"),
      }),
    ).toThrow(/issued for another module/u);
  });

  it("fences every auxiliary frame and closes the stream when the primary goes", async () => {
    const lost: string[] = [];
    const registry = new RunnerRegistry({
      hooks: {
        authorize: vi.fn(async () => undefined),
        onAuxiliaryLost: (_stream, reason) => lost.push(reason),
        onEvent: vi.fn(async () => undefined),
      },
    });
    const runnerId = createId("runner");
    const primary = new MemoryRunnerPeer("runner");
    await registerAttached(registry, browserRunner(runnerId, "boot-1"), primary);
    const auxiliary = new MemoryAuxiliaryPeer("browser");
    const stream = registry.admitAuxiliary({
      claims: ticket(fenceOf(primary)),
      module: "browser",
      peer: auxiliary,
    });

    expect(registry.assertAuxiliaryFence(auxiliary, stream.fence)).toMatchObject({
      auxiliaryStreamId: stream.auxiliaryStreamId,
    });
    expect(() =>
      registry.assertAuxiliaryFence(auxiliary, {
        ...stream.fence,
        connectionGeneration: stream.fence.connectionGeneration + 1,
      }),
    ).toThrow(/stale/u);

    await registry.revoke(runnerId);
    expect(auxiliary.closed).toMatchObject({ code: runnerIdentityRevokedCloseCode });
    expect(lost).toEqual(["revoked"]);
  });

  it("loses a stream to an expired lease as a disconnection, never as a revocation", async () => {
    let now = 1_000;
    const lost: string[] = [];
    const registry = new RunnerRegistry({
      connectionLeaseMs: 50,
      hooks: {
        authorize: vi.fn(async () => undefined),
        onAuxiliaryLost: (_stream, reason) => lost.push(reason),
        onDisconnect: vi.fn(async () => undefined),
        onEvent: vi.fn(async () => undefined),
      },
      now: () => now,
    });
    const runnerId = createId("runner");
    const primary = new MemoryRunnerPeer("runner");
    await registerAttached(registry, browserRunner(runnerId, "boot-1"), primary);
    const auxiliary = new MemoryAuxiliaryPeer("browser");
    registry.admitAuxiliary({
      claims: ticket(fenceOf(primary)),
      module: "browser",
      peer: auxiliary,
    });

    now += 51;
    await new Promise((resolve) => setTimeout(resolve, 60));

    // A machine whose lease ran out is away, not removed. Its sessions have to
    // say so: `revoked` here would end them as `machine-revoked` and tell a
    // person their computer was taken off the Deployment.
    expect(primary.closed).toMatchObject({ code: 4003 });
    expect(primary.closed?.code).not.toBe(runnerIdentityRevokedCloseCode);
    expect(lost).toEqual(["primary-lost"]);
  });
});

describe("disconnecting one named connection", () => {
  it("drops the connection it names and leaves a newer one alone", async () => {
    const registry = new RunnerRegistry({
      hooks: {
        authorize: vi.fn(async () => undefined),
        onDisconnect: vi.fn(async () => undefined),
        onEvent: vi.fn(async () => undefined),
      },
    });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const first = new MemoryRunnerPeer("first");
    const firstIdentity = hello(runnerId, environmentId, "boot-1");
    await registerAttached(registry, firstIdentity, first);

    // The Runner reconnected while the caller was deciding about the boot it
    // had looked at, so the connection it judged is no longer the one here.
    const second = new MemoryRunnerPeer("second");
    const secondIdentity = hello(runnerId, environmentId, "boot-2");
    await registerAttached(registry, secondIdentity, second);

    await expect(
      registry.disconnectConnection(firstIdentity, { code: 1001, reason: "no route" }),
    ).resolves.toBe(false);
    expect(registry.isRunnerConnected(runnerId)).toBe(true);
    expect(second.closed).toBeUndefined();

    await expect(
      registry.disconnectConnection(secondIdentity, { code: 1001, reason: "no route" }),
    ).resolves.toBe(true);
    expect(second.closed).toMatchObject({ code: 1001, reason: "no route" });
    expect(registry.isRunnerConnected(runnerId)).toBe(false);
  });
});

describe("disconnecting the computers that arrived over the route", () => {
  it("drops them as a disconnection, keeps what needed no route, and remembers nothing", async () => {
    const lost: string[] = [];
    const registry = new RunnerRegistry({
      hooks: {
        authorize: vi.fn(async () => undefined),
        onAuxiliaryLost: (_stream, reason) => lost.push(reason),
        onDisconnect: vi.fn(async () => undefined),
        onEvent: vi.fn(async () => undefined),
      },
    });
    const mainId = createId("runner");
    const serviceId = createId("runner");
    const reachableId = createId("runner");
    const mainPeer = new MemoryRunnerPeer("main");
    const servicePeer = new MemoryRunnerPeer("service");
    const reachablePeer = new MemoryRunnerPeer("reachable");
    await registerAttached(registry, hello(mainId, createId("environment"), "boot-1"), mainPeer);
    // A service the Deployment supervises beside its own Host — the messaging
    // service on a Personal stack. The store admits it under no route
    // generation, which is the fact this sweep reads.
    await registerAttached(
      registry,
      {
        ...browserRunner(serviceId, "boot-1"),
        personalRemoteAccessGeneration: null,
        runnerKind: "managed",
      },
      servicePeer,
    );
    await registerAttached(
      registry,
      {
        ...browserRunner(reachableId, "boot-1"),
        personalRemoteAccessGeneration: 3,
        runnerKind: "local",
      },
      reachablePeer,
    );
    const auxiliary = new MemoryAuxiliaryPeer("browser");
    registry.admitAuxiliary({
      claims: ticket(fenceOf(reachablePeer)),
      module: "browser",
      peer: auxiliary,
    });

    await registry.disconnectRouteAdmittedRunners("Remote access was reconfigured");

    // The Main Runner is the machine the change was made on, and the service
    // runs beside it; neither came over the route that changed.
    expect(registry.isRunnerConnected(mainId)).toBe(true);
    expect(mainPeer.closed).toBeUndefined();
    expect(registry.isRunnerConnected(serviceId)).toBe(true);
    expect(servicePeer.closed).toBeUndefined();
    expect(registry.isRunnerConnected(reachableId)).toBe(false);
    // Not 4003, and so not "revoked": every session riding this stream ends as
    // the disconnection this is.
    expect(reachablePeer.closed).toMatchObject({ code: 1001 });
    expect(auxiliary.closed).toMatchObject({ code: 1001 });
    expect(lost).toEqual(["primary-lost"]);

    // Nothing was retired, so the same identity reconnects unaided.
    await expect(
      registry.register(
        {
          ...browserRunner(reachableId, "boot-2"),
          personalRemoteAccessGeneration: 3,
          runnerKind: "local",
        },
        new MemoryRunnerPeer("reachable-again"),
      ),
    ).resolves.toMatchObject({ runnerId: reachableId });
  });
});

class MemoryAuxiliaryPeer {
  readonly id: string;
  closed: { code: number; reason: string } | undefined;

  constructor(id: string) {
    this.id = id;
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function browserRunner(
  runnerId: ReturnType<typeof createId<"runner">>,
  bootId: string,
): RunnerIdentity {
  const base = hello(runnerId, createId("environment"), bootId);
  return {
    ...base,
    allowedModules: ["browser"],
    environmentIds: [],
    modules: { browser: { profileSnapshotVersion: 2, runtimeId: "chromium" } },
  };
}

function ticket(fence: RunnerConnectionFence): RunnerAuxiliaryTicketClaims {
  return {
    audience: "opensteer-runner-auxiliary",
    bootId: fence.bootId,
    connectionGeneration: fence.connectionGeneration,
    connectionId: fence.connectionId,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    issuedAt: new Date().toISOString(),
    module: "browser",
    nonce: "auxiliary-nonce-with-at-least-thirty-two-characters",
    runnerId: fence.runnerId,
  };
}
