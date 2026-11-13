import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { ModelSelectionSchema, OpensteerError, createId, type Message } from "@opensteer/core";
import { SpecialistStore } from "@opensteer/database";
import type { CommandRow, OpensteerStore } from "@opensteer/database";
import { CommandDispatchError } from "@opensteer/orchestration";
import {
  HarnessModelDescriptorSchema,
  RunExecutionContextSchema,
  type RunnerCommand,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { sealRequestResponse } from "../identity/request-response-vault.js";
import { HostCommandDispatcher } from "./dispatcher.js";
describe("HostCommandDispatcher Request responses", () => {
  it("decrypts the sealed response only at Runner dispatch", async () => {
    const vault = new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 9)]]), 1),
    );
    const requestId = createId("request");
    const runId = createId("run");
    const threadId = createId("thread");
    const response = {
      answers: {
        token: ["live-secret"],
      },
      kind: "form" as const,
    };
    const sealed = await sealRequestResponse(vault, response, {
      requestId,
      runId,
      threadId,
    });
    const runnersDispatch = vi.fn(
      async (
        _command,
        _signal,
        options?: {
          readonly beforeAck?: () => Promise<void>;
        },
      ) => {
        await options?.beforeAck?.();
      },
    );
    const dispatchRequestResponse = vi.fn(
      async (_commandId: string, send: (beforeAck: () => Promise<void>) => Promise<void>) => {
        await send(async () => undefined);
        return [];
      },
    );
    const dispatcher = new HostCommandDispatcher({
      teamRequestContext: async () => {
        throw new Error("Unexpected team request");
      },
      executionLeaseMs: 90_000,
      attachmentRunTokens: {
        issue: () => "attachment-token",
      } as never,
      attachments: {
        listForRun: async () => [],
      },
      requestResponseVault: vault,
      runToolTokens: {} as never,
      browser: {} as never,
      egress: {} as never,
      pluginVersions: async () => [],
      pluginsTokens: {} as never,
      onDeploymentEvent: vi.fn(),
      publicUrl: new URL("https://host.example"),
      runners: {
        dispatch: runnersDispatch,
      } as never,
      store: {
        dispatchRequestResponse,
      } as never,
      triggerControlTokens: {} as never,
      triggers: {} as never,
    });
    const command = requestCommand({
      encryptedRequestResponse: sealed.envelope,
      keyVersion: sealed.keyVersion,
      requestId,
      runId,
      threadId,
    });
    await dispatcher.dispatch(command, new AbortController().signal);
    expect(JSON.stringify(command.payload)).not.toContain("live-secret");
    expect(runnersDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        response,
        runId,
        type: "request.resolve",
      }),
      expect.any(AbortSignal),
      {
        beforeAck: expect.any(Function),
      },
    );
    expect(dispatchRequestResponse).toHaveBeenCalledWith(command.id, expect.any(Function));
  });
  it("never opens a response envelope after its Request reservation is cancelled", async () => {
    const open = vi.fn(async () => Buffer.from("unreachable"));
    const runnersDispatch = vi.fn(async () => undefined);
    const requestId = createId("request");
    const runId = createId("run");
    const threadId = createId("thread");
    const dispatcher = new HostCommandDispatcher({
      teamRequestContext: async () => {
        throw new Error("Unexpected team request");
      },
      executionLeaseMs: 90_000,
      attachmentRunTokens: {
        issue: () => "attachment-token",
      } as never,
      attachments: {
        listForRun: async () => [],
      },
      requestResponseVault: {
        fingerprint: vi.fn(),
        open,
        seal: vi.fn(),
      } as never,
      runToolTokens: {} as never,
      browser: {} as never,
      egress: {} as never,
      pluginVersions: async () => [],
      pluginsTokens: {} as never,
      onDeploymentEvent: vi.fn(),
      publicUrl: new URL("https://host.example"),
      runners: {
        dispatch: runnersDispatch,
      } as never,
      store: {
        dispatchRequestResponse: vi.fn(async () => {
          throw new OpensteerError({
            code: "conflict",
            message: "The Request response reservation was cancelled before dispatch",
          });
        }),
      } as never,
      triggerControlTokens: {} as never,
      triggers: {} as never,
    });
    await expect(
      dispatcher.dispatch(
        requestCommand({
          encryptedRequestResponse: Buffer.from("sealed"),
          keyVersion: 1,
          requestId,
          runId,
          threadId,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(open).not.toHaveBeenCalled();
    expect(runnersDispatch).not.toHaveBeenCalled();
  });
});
describe("HostCommandDispatcher steering", () => {
  it("does not send an external steer when access was revoked after claim", async () => {
    const runnersDispatch = vi.fn(async () => undefined);
    const dispatchChannelCommand = vi.fn(async () => {
      throw new OpensteerError({
        code: "forbidden",
        message: "Messaging access changed before dispatch",
      });
    });
    const dispatcher = steerDispatcher({
      dispatchChannelCommand,
      runnersDispatch,
      refuseSteer: vi.fn(async () => []),
      succeedCommand: vi.fn(async () => []),
    });
    const command = {
      ...steerCommand(),
      authoritySource: {
        kind: "channel-ingress",
      },
    };
    await expect(dispatcher.dispatch(command, new AbortController().signal)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(dispatchChannelCommand).toHaveBeenCalledWith(command.id, expect.any(Function));
    expect(runnersDispatch).not.toHaveBeenCalled();
  });
  it.each([undefined, "request-pending"])(
    "compensates through the Thread Inbox when the Runner refuses steering (%s)",
    async (reason) => {
      const requeuedEvent = {
        type: "run.queued",
      } as never;
      const refuseSteer = vi.fn(async () => [requeuedEvent]);
      const succeedCommand = vi.fn(async () => []);
      const onDeploymentEvent = vi.fn();
      const dispatcher = steerDispatcher({
        onDeploymentEvent,
        refuseSteer,
        runnersDispatch: vi.fn(async () => {
          throw new CommandDispatchError(
            "Harness does not support steering",
            "failed",
            reason
              ? {
                  cause: {
                    code: "conflict",
                    message: "Run is stopping",
                    reason,
                    retryable: false,
                  },
                }
              : undefined,
          );
        }),
        succeedCommand,
      });
      const command = steerCommand();
      await expect(
        dispatcher.dispatch(command, new AbortController().signal),
      ).resolves.toBeUndefined();
      expect(refuseSteer).toHaveBeenCalledWith(
        command.id,
        "Harness does not support steering",
        reason,
      );
      expect(onDeploymentEvent).toHaveBeenCalledWith(requeuedEvent);
      expect(succeedCommand).not.toHaveBeenCalled();
    },
  );
  it("leaves a retryable steer to the coordinator", async () => {
    const refuseSteer = vi.fn(async () => []);
    const dispatcher = steerDispatcher({
      refuseSteer,
      runnersDispatch: vi.fn(async () => {
        throw new CommandDispatchError("Runner acknowledgement timed out", "uncertain");
      }),
      succeedCommand: vi.fn(async () => []),
    });
    await expect(
      dispatcher.dispatch(steerCommand(), new AbortController().signal),
    ).rejects.toMatchObject({
      disposition: "uncertain",
    });
    expect(refuseSteer).not.toHaveBeenCalled();
  });
});
describe("HostCommandDispatcher specialist admission", () => {
  it.each([
    "Specialist is pending: browser-profile: rebind (Research)",
    "invoices uses Alice's accounts; add it for yourself to use your own",
    "Specialist registration was removed",
  ])("fails the Run before Runner dispatch: %s", async (message) => {
    const admit = vi
      .spyOn(SpecialistStore.prototype, "assertRunnable")
      .mockRejectedValue(new Error(message));
    const send = vi.fn();
    const requestedBy = createId("user");
    const dispatcher = new HostCommandDispatcher({
      teamRequestContext: async () => {
        throw new Error("Unexpected team request");
      },
      executionLeaseMs: 90000,
      publicUrl: new URL("https://host.example"),
      runners: {
        dispatch: send,
      },
      store: {
        loadRunDispatchContext: async () => ({
          providerSessionStateLayout: "session",
          run: {
            requestedBy,
          },
          thread: {
            specialistId: "registration",
          },
        }),
      },
    } as unknown as ConstructorParameters<typeof HostCommandDispatcher>[0]);
    try {
      await expect(
        dispatcher.dispatch(
          {
            ...steerCommand(),
            type: "run.execute",
            payload: {
              type: "run.execute",
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        message,
        disposition: "failed",
      });
      expect(admit).toHaveBeenCalledWith("registration", requestedBy);
      expect(send).not.toHaveBeenCalled();
    } finally {
      admit.mockRestore();
    }
  });
});
describe("HostCommandDispatcher model selection", () => {
  const gpt5 = {
    displayName: "GPT-5",
    isDefault: true,
    modelId: "gpt-5",
    options: [],
    providerId: "openai",
  };
  const effort = {
    id: "effort",
    label: "Reasoning",
    type: "select",
    values: [
      {
        label: "Low",
        value: "low",
      },
      {
        label: "High",
        value: "high",
      },
    ],
  } as const;
  it("runs the selection with the native id the live catalog reports", async () => {
    const { dispatch, run } = dispatchRun({
      models: [
        {
          displayName: "Llama 4 Maverick",
          isDefault: true,
          modelId: "llama-4-maverick",
          nativeModelId: "meta-llama/llama-4-maverick-2026",
          options: [effort],
          providerId: "meta",
        },
      ],
      modelSelection: {
        modelId: "llama-4-maverick",
        nativeModelId: "meta-llama/llama-4-maverick",
        options: {
          effort: "high",
        },
        providerId: "meta",
      },
    });
    await run();
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelSelection: {
            modelId: "llama-4-maverick",
            nativeModelId: "meta-llama/llama-4-maverick-2026",
            options: {
              effort: "high",
            },
            providerId: "meta",
          },
        }),
      }),
      expect.any(AbortSignal),
      expect.objectContaining({
        connectionGeneration: 7,
      }),
    );
  });
  it("states every default the selection leaves out and carries options the model stopped listing", async () => {
    // A Codex thread keeps the last level and speed it was told, so an unnamed
    // option is stated at the live default; an option the catalog no longer
    // lists belongs to the driver (Cursor reads its older tuples, and a plan
    // can stop offering a toggle a Thread never turned on).
    const { dispatch, run } = dispatchRun({
      models: [
        {
          displayName: "GPT-6 Astra",
          isDefault: true,
          modelId: "gpt-6-astra",
          options: [
            {
              ...effort,
              defaultValue: "high",
            },
            {
              defaultValue: false,
              id: "fast",
              label: "Fast mode",
              type: "toggle",
            },
          ],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-6-astra",
        options: {
          fast: true,
          thinking: true,
        },
        providerId: "openai",
      },
    });
    await run();
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelSelection: {
            modelId: "gpt-6-astra",
            options: {
              effort: "high",
              fast: true,
              thinking: true,
            },
            providerId: "openai",
          },
        }),
      }),
      expect.any(AbortSignal),
      expect.objectContaining({
        connectionGeneration: 7,
      }),
    );
  });
  it("fails a Run whose option value the running engine no longer lists", async () => {
    const { dispatch, run } = dispatchRun({
      models: [
        {
          displayName: "GPT-5.5",
          isDefault: true,
          modelId: "gpt-5.5",
          options: [effort],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-5.5",
        options: {
          effort: "xhigh",
        },
        providerId: "openai",
      },
    });
    await expect(run()).rejects.toMatchObject({
      disposition: "failed",
      message: "Model option effort is not available for GPT-5.5; it takes low, high",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("fails a Run whose model the running engine no longer lists", async () => {
    const { dispatch, run } = dispatchRun({
      models: [
        {
          displayName: "GPT-6",
          isDefault: true,
          modelId: "gpt-6",
          options: [],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-5.5",
        options: {},
        providerId: "openai",
      },
    });
    await expect(run()).rejects.toMatchObject({
      disposition: "failed",
      message: "The selected model is no longer available in this AI engine.",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("fails before dispatch when defaults plus carried legacy options exceed the wire limit", async () => {
    const legacy = Object.fromEntries(
      Array.from(
        {
          length: 16,
        },
        (_, index) => [`legacy${index}`, true],
      ),
    );
    const { dispatch, run } = dispatchRun({
      models: [
        {
          displayName: "GPT-6",
          isDefault: true,
          modelId: "gpt-6",
          options: [
            {
              defaultValue: false,
              id: "fast",
              label: "Fast mode",
              type: "toggle",
            },
          ],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-6",
        options: legacy,
        providerId: "openai",
      },
    });
    await expect(run()).rejects.toMatchObject({
      disposition: "failed",
      message: "The selected model has too many options to run with this saved configuration.",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("dispatches when carried options and a current default fit the wire limit exactly", async () => {
    const legacy = Object.fromEntries(
      Array.from(
        {
          length: 15,
        },
        (_, index) => [`legacy${index}`, true],
      ),
    );
    const { dispatch, run } = dispatchRun({
      models: [
        {
          displayName: "GPT-6",
          isDefault: true,
          modelId: "gpt-6",
          options: [
            {
              defaultValue: false,
              id: "fast",
              label: "Fast mode",
              type: "toggle",
            },
          ],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-6",
        options: legacy,
        providerId: "openai",
      },
    });
    await run();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelSelection: {
            modelId: "gpt-6",
            options: {
              fast: false,
              ...legacy,
            },
            providerId: "openai",
          },
        }),
      }),
      expect.any(AbortSignal),
      expect.objectContaining({
        connectionGeneration: 7,
      }),
    );
  });
  it("issues a scoped attachment plan even for a text-only continuation on a capable Runner", async () => {
    const { dispatch, run } = dispatchRun({
      supportsAttachments: true,
      models: [
        {
          displayName: "GPT-5",
          isDefault: true,
          modelId: "gpt-5",
          options: [],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
    });
    await run();
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          attachments: {
            token: "attachment-token",
          },
        }),
      }),
      expect.any(AbortSignal),
      expect.objectContaining({
        connectionGeneration: 7,
      }),
    );
  });
  it("keeps text-only commands compatible with Runners without attachment support", async () => {
    const { dispatch, run } = dispatchRun({
      models: [
        {
          displayName: "GPT-5",
          isDefault: true,
          modelId: "gpt-5",
          options: [],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
    });
    await run();
    const sent = dispatch.mock.calls[0]?.[0];
    if (!sent || sent.type !== "run.execute") throw new Error("Expected a Run dispatch");
    expect(sent.context).not.toHaveProperty("attachments");
  });
  it("refuses an older Runner when prior admitted files fall outside the history window", async () => {
    const { dispatch, run } = dispatchRun({
      hasHistoricalAttachments: true,
      models: [
        {
          displayName: "GPT-5",
          isDefault: true,
          modelId: "gpt-5",
          options: [],
          providerId: "openai",
        },
      ],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
    });
    await expect(run()).rejects.toMatchObject({
      disposition: "failed",
      message: expect.stringContaining("attachments"),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("tells the Run the time zone its requester's client last reported", async () => {
    const { dispatch, requestedBy, run, timeZoneFor } = dispatchRun({
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
      requesterTimeZone: "America/New_York",
    });
    await run();
    expect(timeZoneFor).toHaveBeenCalledWith(requestedBy);
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          requesterTimeZone: "America/New_York",
        }),
      }),
      expect.any(AbortSignal),
      expect.objectContaining({
        connectionGeneration: 7,
      }),
    );
  });
  it("says plainly that the requester's time zone is unknown when no client reported one", async () => {
    const { dispatch, run } = dispatchRun({
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
    });
    await run();
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          requesterTimeZone: null,
        }),
      }),
      expect.any(AbortSignal),
      expect.objectContaining({
        connectionGeneration: 7,
      }),
    );
  });
  it("refuses the new tool plan on an old Runner with a visible update reason", async () => {
    const { dispatch, run } = dispatchRun({
      capabilities: [
        "native-session-continuation-v1",
        "assignments-v1",
        "thread-state-v1",
        "requester-time-zone-v1",
        "execution-plane-v2",
      ],
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
    });
    await expect(run()).rejects.toMatchObject({
      disposition: "failed",
      message: "Update this computer to use Opensteer tools.",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("asks a Runner that cannot carry the requester's time zone to update instead of running", async () => {
    const { dispatch, run, timeZoneFor } = dispatchRun({
      capabilities: [
        "native-session-continuation-v1",
        "assignments-v1",
        "thread-state-v1",
        "execution-plane-v2",
        "agent-tools-plan-v1",
      ],
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
      requesterTimeZone: "America/New_York",
    });
    await expect(run()).rejects.toMatchObject({
      disposition: "failed",
      message: "Update this Runner so agents know the person's time zone.",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(timeZoneFor).not.toHaveBeenCalled();
  });
  it("asks a Runner that may leave a message steered into a conversation unanswered to update", async () => {
    const older = [
      "native-session-continuation-v1",
      "assignments-v1",
      "thread-state-v1",
      "requester-time-zone-v1",
      "execution-plane-v2",
      "agent-tools-plan-v1",
    ];
    const conversation = dispatchRun({
      capabilities: older,
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
      purpose: "voice",
    });
    await expect(conversation.run()).rejects.toMatchObject({
      disposition: "failed",
      message: "Update this Runner so messages sent while Opensteer replies are answered.",
    });
    expect(conversation.dispatch).not.toHaveBeenCalled();

    // A work Thread never hands a message over on its own, so it still runs there.
    const work = dispatchRun({
      capabilities: older,
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
      purpose: "task",
    });
    await work.run();
    expect(work.dispatch).toHaveBeenCalledOnce();
    const current = dispatchRun({
      capabilities: [...older, "steer-answer-v1"],
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
      purpose: "voice",
    });
    await current.run();
    expect(current.dispatch).toHaveBeenCalledOnce();
  });
  it("refuses policy-bearing Runs on an older Runner and sends policy to a capable Runner", async () => {
    const input = {
      models: [gpt5],
      modelSelection: {
        modelId: "gpt-5",
        options: {},
        providerId: "openai",
      },
      skillPolicy: {
        revision: 3,
        disabledFullNames: ["release"],
      },
    };
    const older = dispatchRun(input);
    await expect(older.run()).rejects.toMatchObject({
      disposition: "failed",
      message: "Update this Runner to enforce skill settings.",
    });
    expect(older.dispatch).not.toHaveBeenCalled();
    const current = dispatchRun({
      ...input,
      capabilities: [
        "settings-plugin-policy-v1",
        "agent-tools-plan-v1",
        "native-session-continuation-v1",
        "assignments-v1",
        "thread-state-v1",
        "requester-time-zone-v1",
        "execution-plane-v2",
      ],
    });
    await current.run();
    expect(current.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          plugins: expect.objectContaining({
            skillPolicy: input.skillPolicy,
          }),
        }),
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
  it("dispatches a specialist through the Runner wire schema", async () => {
    const admit = vi
      .spyOn(SpecialistStore.prototype, "assertRunnable")
      .mockResolvedValue(undefined as never);
    try {
      const { dispatch, run } = dispatchRun({
        specialistId: "registration",
        models: [gpt5],
        modelSelection: {
          modelId: "gpt-5",
          options: {},
          providerId: "openai",
        },
      });
      await run();
      const command = dispatch.mock.calls[0]![0];
      if (command.type !== "run.execute") throw new Error("Expected run.execute");
      expect(command.context.specialistId).toBe("registration");
      expect(RunExecutionContextSchema.parse(command.context)).toEqual(command.context);
    } finally {
      admit.mockRestore();
    }
  });
  function dispatchRun(input: {
    readonly specialistId?: string;
    readonly capabilities?: readonly string[];
    readonly skillPolicy?: import("@opensteer/protocol").RunPluginsPlan["skillPolicy"];
    readonly purpose?: "task" | "voice";
    readonly supportsAttachments?: boolean;
    readonly hasHistoricalAttachments?: boolean;
    readonly models: readonly unknown[];
    readonly modelSelection: unknown;
    readonly requesterTimeZone?: string | null;
  }) {
    const models = input.models.map((model) => HarnessModelDescriptorSchema.parse(model));
    const modelSelection = ModelSelectionSchema.parse(input.modelSelection);
    const environmentId = createId("environment");
    const computerId = createId("runner");
    const harnessInstanceId = createId("harnessInstance");
    const requestedBy = createId("user");
    const runId = createId("run");
    const threadId = createId("thread");
    const dispatch = vi.fn(async (_command: RunnerCommand, _signal: AbortSignal) => undefined);
    const timeZoneFor = vi.fn(async () => input.requesterTimeZone ?? null);
    const specialistQuery = {
      selectFrom: () => specialistQuery,
      innerJoin: () => specialistQuery,
      select: () => specialistQuery,
      where: () => specialistQuery,
      executeTakeFirst: async () => ({
        pluginId: "plugin",
        name: "proof",
        digest: "a".repeat(64),
      }),
    };
    const dispatcher = new HostCommandDispatcher({
      teamRequestContext: async () => {
        throw new Error("Unexpected team request");
      },
      executionLeaseMs: 90_000,
      attachmentRunTokens: {
        issue: () => "attachment-token",
      } as never,
      attachments: {
        listForRun: async () => (input.hasHistoricalAttachments ? [{}] : []),
      } as never,
      requestResponseVault: {} as never,
      runToolTokens: {
        lifetimeSeconds: 120,
        issue: () => "agent-token",
      } as never,
      browser: {} as never,
      egress: {
        issue: () => ({
          relayToken: "egress-token",
          relayUrl: "https://host.example/internal/v1/egress",
          maxRequestBytes: 1024,
          maxResponseBytes: 1024,
        }),
      } as never,
      skillPolicy: async () => input.skillPolicy,
      pluginVersions: async () => [],
      pluginsTokens: {
        issue: () => "skills-token",
      } as never,
      onDeploymentEvent: vi.fn(),
      publicUrl: new URL("https://host.example"),
      runners: {
        supportsMessageAttachments: () => input.supportsAttachments ?? false,
        canRunHarness: () => true,
        dispatch,
        identityForEnvironment: () => ({
          bootId: "boot-run",
          connectionGeneration: 7,
          capabilities: input.capabilities ?? [
            "native-session-continuation-v1",
            "assignments-v1",
            "thread-state-v1",
            "requester-time-zone-v1",
            "execution-plane-v2",
            "agent-tools-plan-v1",
          ],
          name: "Run computer",
          runnerId: computerId,
          modules: { agents: {} },
        }),
        inspectHarnesses: async () => [
          {
            continuationIdentity: "continuation-test",
            models,
            status: "ready",
          },
        ],
      } as never,
      store: {
        database: specialistQuery,
        acquireExecutionBinding: async () => ({
          bindingGeneration: 1,
          continuationEvent: null,
          providerSessionId: createId("providerSession"),
          providerSessionReference: null,
        }),
        assertActiveGrant: async () => undefined,
        renewActiveExecutionBindings: async () => [],
        listReachableMachines: async () => [],
        getHarnessInstance: async () => ({
          config: {},
          driverKind: "codex",
          enabled: true,
          environmentId,
          id: harnessInstanceId,
          name: "Codex",
          sourceId: "openai",
          runtimeRevision: 1,
          stateKind: "ambient",
        }),
        loadRunThreadState: async () => ({
          previousAssignment: null,
          previousRun: null,
        }),
        loadRunDispatchContext: async () => ({
          providerSessionStateLayout: "session",
          personalContext: true,
          agentHome: { computerId, path: "/tmp/dispatcher" },
          history: [],
          historyWindow: {
            byteCount: 0,
            itemCount: 0,
            hasEarlier: false,
          },
          inputs: [],
          reports: {
            messages: [],
            omittedCount: 0,
            throughSequence: null,
          },
          run: {
            accessMode: "full-access",
            environmentId,
            harnessInstanceId,
            id: runId,
            modelSelection,
            requestedBy,
          },
          thread: {
            ...(input.specialistId
              ? {
                  specialistId: input.specialistId,
                }
              : {}),
            id: threadId,
            purpose: input.purpose ?? "task",
            teamOrigin: null,
            accessMode: "full-access",
          },
        }),
        notificationState: {
          timeZoneFor,
        },
        recordHarnessCatalogs: async ({
          catalogs,
        }: Parameters<OpensteerStore["recordHarnessCatalogs"]>[0]) => catalogs,
      } as never,
      triggerControlTokens: {} as never,
      triggers: {} as never,
    });
    const command = {
      ...steerCommand(),
      environmentId,
      payload: {
        type: "run.execute",
      },
      runId,
      threadId,
      type: "run.execute" as const,
    };
    return {
      dispatch,
      requestedBy,
      run: () => dispatcher.dispatch(command as CommandRow, new AbortController().signal),
      timeZoneFor,
    };
  }
});
describe("HostCommandDispatcher run planning", () => {
  it.each([null, "native-conversation"])(
    "plans a Run using its proven provider session (%s)",
    async (providerSessionReference) => {
      const environmentId = createId("environment");
      const requestedBy = createId("user");
      const runId = createId("run");
      const threadId = createId("thread");
      const harnessInstanceId = createId("harnessInstance");
      const identity = {
        bootId: "boot-run",
        connectionGeneration: 7,
        capabilities: [
          "native-session-continuation-v1",
          "assignments-v1",
          "thread-state-v1",
          "requester-time-zone-v1",
          "execution-plane-v2",
          "agent-tools-plan-v1",
        ],
        name: "Run computer",
        runnerId: createId("runner"),
      };
      const agentHome = { computerId: identity.runnerId, path: "/tmp/dispatcher/home" };
      const dispatch = vi.fn(async () => undefined);
      const command = {
        ...steerCommand(),
        environmentId,
        payload: {
          type: "run.execute",
        },
        requestedBy,
        runId,
        threadId,
        type: "run.execute" as const,
      };
      const dispatcher = new HostCommandDispatcher({
        teamRequestContext: async () => {
          throw new Error("Unexpected team request");
        },
        executionLeaseMs: 90_000,
        attachmentRunTokens: {
          issue: () => "attachment-token",
        } as never,
        attachments: {
          listForRun: async () => [],
        },
        requestResponseVault: {} as never,
        runToolTokens: {
          lifetimeSeconds: 120,
          issue: () => "agent-token",
        } as never,
        browser: {} as never,
        egress: {
          issue: () => ({
            relayToken: "egress-token",
            relayUrl: "https://host.example/internal/v1/egress",
            maxRequestBytes: 1024,
            maxResponseBytes: 1024,
          }),
        } as never,
        pluginVersions: async () => [],
        pluginsTokens: {
          issue: () => "skills-token",
        } as never,
        onDeploymentEvent: vi.fn(),
        publicUrl: new URL("https://host.example"),
        runners: {
          supportsMessageAttachments: () => false,
          canRunHarness: () => true,
          dispatch,
          identityForEnvironment: () => identity,
          inspectHarnesses: async () => [
            {
              continuationIdentity: "continuation-test",
              models: [
                {
                  displayName: "GPT-5",
                  isDefault: true,
                  modelId: "gpt-5",
                  options: [],
                  providerId: "openai",
                },
              ],
              status: "ready",
            },
          ],
        } as never,
        store: {
          acquireExecutionBinding: async () => ({
            bindingGeneration: 2,
            continuationEvent: null,
            providerSessionId: createId("providerSession"),
            providerSessionReference,
          }),
          assertActiveGrant: async () => undefined,
          renewActiveExecutionBindings: async () => [],
          // No computer this Run may reach, so the command carries only its own computer name.
          listReachableMachines: async () => [],
          getHarnessInstance: async () => ({
            config: {},
            driverKind: "codex",
            enabled: true,
            environmentId,
            id: harnessInstanceId,
            name: "Codex",
            runtimeRevision: 1,
            stateKind: "ambient",
          }),
          loadRunThreadState: async () => ({
            previousAssignment: null,
            previousRun: null,
          }),
          loadRunDispatchContext: async () => ({
            providerSessionStateLayout: "session",
            personalContext: true,
            agentHome,
            history: [
              {
                id: "old-failed-input",
                content: [
                  {
                    type: "text",
                    text: "Earlier input",
                  },
                ],
              },
            ],
            historyWindow: {
              byteCount: 100,
              itemCount: 1,
              hasEarlier: false,
            },
            inputs: [],
            reports: {
              messages: [],
              omittedCount: 0,
              throughSequence: null,
            },
            run: {
              accessMode: "full",
              environmentId,
              harnessInstanceId,
              id: runId,
              modelSelection: {
                modelId: "gpt-5",
                options: {},
                providerId: "openai",
              },
              requestedBy,
            },
            thread: {
              id: threadId,
              purpose: "task",
              teamOrigin: null,
            },
          }),
          notificationState: {
            timeZoneFor: async () => null,
          },
          recordHarnessCatalogs: async ({
            catalogs,
          }: Parameters<OpensteerStore["recordHarnessCatalogs"]>[0]) => catalogs,
        } as never,
        triggerControlTokens: {} as never,
        triggers: {} as never,
      });
      await dispatcher.dispatch(command, new AbortController().signal);
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            machineAccess: {
              callerMachineName: "Run computer",
              machines: [],
              omittedMachines: 0,
            },
            history: providerSessionReference
              ? [
                  {
                    id: "old-failed-input",
                    content: [
                      {
                        type: "text",
                        text: "Earlier input",
                      },
                    ],
                  },
                ]
              : [],
            historyWindow: {
              byteCount: providerSessionReference ? 100 : 0,
              itemCount: providerSessionReference ? 1 : 0,
              hasEarlier: false,
            },
            // One Host credential: the tool plan's.
            agentTools: expect.objectContaining({
              token: "agent-token",
            }),
            browserCdp: {
              url: "https://host.example/internal/v1/browser-cdp",
            },
          }),
          type: "run.execute",
          agentHome,
        }),
        expect.any(AbortSignal),
        expect.objectContaining({
          connectionGeneration: 7,
        }),
      );
      const [sent] = dispatch.mock.lastCall as unknown as [
        {
          readonly context: object;
        },
      ];
      expect(sent.context).not.toHaveProperty("agentControl");
    },
  );
});
function steerDispatcher(input: {
  readonly onDeploymentEvent?: () => void;
  readonly dispatchChannelCommand?: OpensteerStore["dispatchChannelCommand"];
  readonly refuseSteer: () => Promise<readonly never[]>;
  readonly runnersDispatch: () => Promise<undefined>;
  readonly succeedCommand: () => Promise<readonly never[]>;
}): HostCommandDispatcher {
  return new HostCommandDispatcher({
    teamRequestContext: async () => {
      throw new Error("Unexpected team request");
    },
    executionLeaseMs: 90_000,
    attachmentRunTokens: {
      issue: () => "attachment-token",
    } as never,
    attachments: {
      listForRun: async () => [],
    },
    requestResponseVault: {} as never,
    runToolTokens: {} as never,
    browser: {} as never,
    egress: {} as never,
    pluginVersions: async () => [],
    pluginsTokens: {} as never,
    onDeploymentEvent: input.onDeploymentEvent ?? vi.fn(),
    publicUrl: new URL("https://host.example"),
    runners: {
      dispatch: input.runnersDispatch,
    } as never,
    store: {
      dispatchChannelCommand: input.dispatchChannelCommand,
      loadSteerDispatchInput: async () => ({
        message: steerMessage(),
        runId: createId("run"),
        threadId: createId("thread"),
      }),
      refuseSteer: input.refuseSteer,
      succeedCommand: input.succeedCommand,
    } as never,
    triggerControlTokens: {} as never,
    triggers: {} as never,
  });
}
function steerCommand(): CommandRow {
  const now = new Date();
  const runId = createId("run");
  const threadId = createId("thread");
  return {
    requestResponseKeyVersion: null,
    actorPrincipalId: "pri_00000000-0000-4000-8000-000000000099" as CommandRow["actorPrincipalId"],
    attempts: 1,
    authoritySource: {
      kind: "thread-agent",
    },
    createdAt: now,
    dispatcherId: "test",
    encryptedRequestResponse: null,
    environmentId: createId("environment"),
    id: createId("command"),
    idempotencyKey: "inbox-steer",
    lastError: null,
    payload: {
      runId,
      threadId,
      type: "run.steer",
    },
    requestedBy: createId("user"),
    runId,
    status: "dispatched",
    threadId,
    type: "run.steer",
    updatedAt: now,
  };
}
function steerMessage(): Message {
  return {
    author: {
      displayName: "Contract research",
      kind: "agent",
      runId: createId("run"),
      threadId: createId("thread"),
    },
    content: [
      {
        text: "The contract is signed",
        type: "text",
      },
    ],
    createdAt: new Date().toISOString(),
    id: createId("message"),
    kind: "input",
    runId: null,
    sequence: "1" as Message["sequence"],
    threadId: createId("thread"),
  };
}
function requestCommand(input: {
  readonly encryptedRequestResponse: Buffer;
  readonly keyVersion: number;
  readonly requestId: ReturnType<typeof createId<"request">>;
  readonly runId: ReturnType<typeof createId<"run">>;
  readonly threadId: ReturnType<typeof createId<"thread">>;
}): CommandRow {
  const now = new Date();
  return {
    requestResponseKeyVersion: input.keyVersion,
    actorPrincipalId: "pri_00000000-0000-4000-8000-000000000099" as CommandRow["actorPrincipalId"],
    attempts: 1,
    authoritySource: {
      kind: "user-session",
    },
    createdAt: now,
    dispatcherId: "test",
    encryptedRequestResponse: input.encryptedRequestResponse,
    environmentId: createId("environment"),
    id: createId("command"),
    idempotencyKey: "request-response",
    lastError: null,
    payload: {
      requestId: input.requestId,
      requestedBy: createId("user"),
      response: {
        answers: {
          token: [],
        },
        kind: "form",
      },
      responseFingerprint: "hmac-sha256-v1:1:test",
      runId: input.runId,
      threadId: input.threadId,
      type: "request.respond",
    },
    requestedBy: createId("user"),
    runId: input.runId,
    status: "dispatched",
    threadId: input.threadId,
    type: "request.respond",
    updatedAt: now,
  };
}
