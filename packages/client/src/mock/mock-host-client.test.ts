import { describe, expect, it, vi } from "vitest";
import {
  IntegrationDashboardSchema,
  IntegrationPlatformDashboardSchema,
} from "@opensteer/integration-core";

import {
  AgentEventSchema,
  BrowserSessionIdSchema,
  createId,
  DEFAULT_THREAD_ACCESS_MODE,
  ModelSelectionSchema,
  RequestSchema,
  type ThreadAccessMode,
  type PlaceContentPart,
} from "@opensteer/core";
import { hostApi } from "@opensteer/protocol";
import type { ThreadSummary, CreateThreadInput } from "../host/client.js";
import { threadStopTarget } from "../host/thread-activity.js";
import { defaultThreadPlacement, threadPlacementOptions } from "../host/thread-placement.js";
import { MockHostClient } from "./mock-host-client.js";

it("carries pending profile erasure through the mock catalog and clears completed jobs", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const deletion = {
      profileId: createId("browserProfile"),
      computerId: createId("runner"),
      state: "pending-restart" as const,
    };
    client.setBrowserProfileDeletions([deletion]);
    expect(client.getSnapshot().browserProfileDeletions).toEqual([deletion]);
    const catalog = unwrap(await client.rpc["bootstrap.get"]({}));
    expect(catalog.browser.profileDeletions).toEqual([deletion]);
    client.setBrowserProfileDeletions([]);
    expect(unwrap(await client.rpc["bootstrap.get"]({})).browser.profileDeletions).toEqual([]);
  } finally {
    client.dispose();
  }
});

const fixedNow = new Date("2026-08-09T21:15:00.000Z");

function createClient(): MockHostClient {
  return new MockHostClient({ latencyMs: 0, now: () => fixedNow });
}

it("implements installed-engine update commands in the mock", async () => {
  const client = createClient();
  try {
    const environment = client.getSnapshot().environments[0];
    if (!environment) throw new Error("Mock environment missing");
    const result = await client.dispatch({
      driverKind: "codex",
      environmentId: environment.id,
      idempotencyKey: "update-codex",
      type: "harness.update",
    });
    expect(result).toMatchObject({
      installation: { update: "succeeded", version: "0.163.0" },
      type: "harness.update",
    });
    expect(
      client
        .getSnapshot()
        .environments[0]?.harnessDrivers.find((driver) => driver.driverKind === "codex")
        ?.installation?.update,
    ).toBe("succeeded");
  } finally {
    client.dispose();
  }
});

/**
 * The tuple a composer resolves before starting a Thread. `createThread` fills
 * nothing in, so every test names where work runs, on which account and model.
 */
function threadInput(
  client: MockHostClient,
  workspaceId: string,
  options: {
    readonly accessMode?: ThreadAccessMode;
    readonly environmentId?: string;
    readonly harnessInstanceId?: string;
  } = {},
): CreateThreadInput {
  const { environments, harnesses } = client.getSnapshot();
  const placement =
    options.environmentId && options.harnessInstanceId
      ? threadPlacementOptions(environments, harnesses).find(
          (option) =>
            option.environmentId === options.environmentId &&
            option.harnessInstanceId === options.harnessInstanceId,
        )
      : defaultThreadPlacement(environments, harnesses);
  if (!placement) throw new Error("The mock offers no such placement.");
  return {
    accessMode: options.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
    environmentId: placement.environmentId,
    harnessInstanceId: placement.harnessInstanceId,
    modelSelection: placement.modelSelection,
    workspaceId,
  };
}

async function sendMessage(client: MockHostClient, threadId: string, body: string) {
  if (!body.trim()) return;
  return client.dispatch({
    content: [{ text: body, type: "text" }],
    idempotencyKey: `mock-message:${crypto.randomUUID()}`,
    threadId,
    type: "thread.sendMessage",
  });
}

function unwrap<Success>(
  result:
    | { readonly data: Success; readonly ok: true }
    | { readonly error: { readonly message: string }; readonly ok: false },
): Success {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

/** Narrows a send's dispatch result to the message, input and (possibly absent) Run it created. */
function unwrapSend(result: Awaited<ReturnType<typeof sendMessage>>) {
  if (!result || result.type !== "thread.sendMessage") throw new Error("Command mismatch.");
  return result;
}

async function integrations(client: MockHostClient) {
  const result = await client.rpc["integrations.get"]({});
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

async function integrationPlatform(client: MockHostClient) {
  const result = await client.rpc["integration.platform.get"]({});
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

async function integrationGrants(client: MockHostClient, workspaceId: string) {
  const result = await client.rpc["integration.grants.list"]({ workspaceId });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.grants;
}

describe("MockHostClient", () => {
  it.each(["rename", "icon", "default", "chosen title"] as const)(
    "settles title and icon independently after %s",
    async (choice) => {
      const client = createClient();
      try {
        const thread = await client.createThread({
          ...threadInput(client, client.getSnapshot().workspaces[0]!.id),
          title: "Chosen task title",
          ...(choice !== "chosen title" ? { generateTitle: true } : {}),
        });
        expect(thread.icon).toBeNull();
        await sendMessage(client, thread.id, "Book a hotel in Seoul for May");
        if (choice === "rename") await client.renameThread(thread.id, "My hotel booking");
        if (choice === "icon" || choice === "default")
          await client.dispatch({
            type: "thread.icon.set",
            threadId: thread.id,
            icon: choice === "default" ? null : "gift",
            idempotencyKey: `choice-${choice}`,
          });
        await vi.waitFor(() => {
          const current = client.getSnapshot().threads.find(({ id }) => id === thread.id)!;
          expect(current.icon).not.toBeNull();
          expect(current.title).toBe(
            choice === "rename"
              ? "My hotel booking"
              : choice === "chosen title"
                ? "Chosen task title"
                : "Book a hotel in Seoul",
          );
        });
        const current = client.getSnapshot().threads.find(({ id }) => id === thread.id)!;
        expect(current.icon).toBe(
          choice === "default" ? "document" : choice === "icon" ? "gift" : "hotel",
        );
        expect(current.title).toBe(
          choice === "rename"
            ? "My hotel booking"
            : choice === "chosen title"
              ? "Chosen task title"
              : "Book a hotel in Seoul",
        );
        expect(current.color).toBe(thread.color);
      } finally {
        client.dispose();
      }
    },
  );

  it("settles an unclassified mock name to document and allocates seven serial colours independently of specialist colour", async () => {
    const client = createClient();
    try {
      const workspace = client.getSnapshot().workspaces[0]!;
      const threads: ThreadSummary[] = [];
      for (let index = 0; index < 7; index += 1)
        threads.push(
          await client.createThread({
            ...threadInput(client, workspace.id),
            title: `Task ${index}`,
          }),
        );
      expect(new Set(threads.map((thread) => thread.color)).size).toBe(7);
      await sendMessage(client, threads[0]!.id, "Something entirely unclassified");
      await vi.waitFor(() =>
        expect(client.getSnapshot().threads.find(({ id }) => id === threads[0]!.id)?.icon).toBe(
          "document",
        ),
      );
      const specialist = client
        .getSnapshot()
        .workspaces.find(({ kind }) => kind === "specialized")!;
      const before = client.getSnapshot().threads.map(({ id, color }) => ({ id, color }));
      const result = await client.dispatch({
        type: "workspace.color.set",
        workspaceId: specialist.id,
        color: "magenta",
        idempotencyKey: "specialist-color",
      });
      expect(result).toMatchObject({
        type: "workspace.color.set",
        workspace: { color: "magenta" },
      });
      expect(client.getSnapshot().threads.map(({ id, color }) => ({ id, color }))).toEqual(before);
      expect(client.getSnapshot().taskMarksAvailable).toBe(true);
      await expect(
        client.dispatch({
          type: "thread.icon.set",
          threadId: client.getSnapshot().homeThreadId!,
          icon: "hotel",
          idempotencyKey: "chat-icon",
        }),
      ).rejects.toThrow("Chat");
      await expect(
        client.dispatch({
          type: "workspace.color.set",
          workspaceId: workspace.id,
          color: "blue",
          idempotencyKey: "main-color",
        }),
      ).rejects.toThrow("Main");
    } finally {
      client.dispose();
    }
  });

  it.each(["browser-page", "computer-app", "phone"] as const)(
    "keeps the seed after a first message containing only a %s, including later authored messages",
    async (kind) => {
      const client = createClient();
      try {
        const snapshot = client.getSnapshot();
        const session = snapshot.browserSessions[0]!;
        const place: PlaceContentPart =
          kind === "browser-page"
            ? {
                type: kind,
                sessionId: BrowserSessionIdSchema.parse(session.id),
                tabId: session.tabs[0]!.id,
                title: "A page with a different name",
                url: "https://example.com",
              }
            : kind === "computer-app"
              ? {
                  type: kind,
                  machineId: createId("runner"),
                  name: "Notes",
                  app: { bundleId: "com.apple.Notes", teamId: null, displayName: "Notes" },
                }
              : { type: kind, machineId: createId("runner"), display: "main", name: "My phone" };
        const thread = await client.createThread({
          ...threadInput(client, snapshot.workspaces[0]!.id),
          title: "Keep this seed",
          generateTitle: true,
        });
        await client.dispatch({
          type: "thread.sendMessage",
          threadId: thread.id,
          content: [{ type: "text", text: "  \n " }, place],
          idempotencyKey: `place-only:${kind}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.title).toBe(
          thread.title,
        );
        await sendMessage(client, thread.id, "A later authored message must not name this task");
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.title).toBe(
          thread.title,
        );
      } finally {
        client.dispose();
      }
    },
  );

  it("keeps a queue resume answer when an older paused state event is replayed", async () => {
    const client = createClient();
    const thread = client.getSnapshot().threads[0]!;
    const event = AgentEventSchema.parse({
      createdAt: fixedNow.toISOString(),
      data: { inputQueuePaused: true, pendingRequests: 0, status: "waiting" },
      environmentId: thread.environmentId,
      eventId: createId("event"),
      runId: null,
      sequence: "1",
      threadId: thread.id,
      type: "thread.state-changed",
      workspaceId: thread.workspaceId,
    });
    if (event.type !== "thread.state-changed") throw new Error("Wrong event type");
    try {
      client.applyThreadStateChanged(event);
      const result = await client.dispatch({
        type: "thread.inputQueue.resume",
        threadId: thread.id,
        idempotencyKey: "resume-state-replay",
      });
      if (result.type !== "thread.inputQueue.resume") throw new Error("Wrong command type");
      expect(BigInt(result.asOfSequence)).toBeGreaterThan(BigInt(event.sequence));
      expect(result.thread.inputQueuePaused).toBe(false);
      client.applyThreadStateChanged(event);
      expect(
        client.getSnapshot().threads.find(({ id }) => id === thread.id)?.inputQueuePaused,
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it("applies the Host's Thread status without deriving it from the mock Run queue", () => {
    const client = createClient();
    const thread = client.getSnapshot().threads[0]!;
    const event = AgentEventSchema.parse({
      createdAt: fixedNow.toISOString(),
      data: { inputQueuePaused: false, pendingRequests: 0, status: "failed" },
      environmentId: thread.environmentId,
      eventId: createId("event"),
      runId: null,
      sequence: "1",
      threadId: thread.id,
      type: "thread.state-changed",
      workspaceId: thread.workspaceId,
    });
    if (event.type !== "thread.state-changed") throw new Error("Wrong event type");
    client.applyThreadStateChanged(event);
    expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.status).toBe("failed");
    client.dispose();
  });

  it("starts the no-Home fixture without orphaning Chat state or unrelated requests", async () => {
    const client = new MockHostClient({
      initialHome: "absent",
      latencyMs: 0,
      now: () => fixedNow,
    });
    const snapshot = client.getSnapshot();
    const workspaceId = snapshot.homeWorkspaceId;
    const initialHomeId = createClient().getSnapshot().homeThreadId;
    expect(workspaceId).not.toBeNull();
    expect(initialHomeId).not.toBeNull();
    if (workspaceId === null || initialHomeId === null)
      throw new Error("Missing fixture identifiers");

    expect(snapshot.homeThreadId).toBeNull();
    expect(
      snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.homeThreadId,
    ).toBeNull();
    expect(snapshot.threads.some((thread) => thread.id === initialHomeId)).toBe(false);
    expect(snapshot.transcripts[initialHomeId]).toBeUndefined();
    expect(snapshot.transcriptWindows[initialHomeId]).toBeUndefined();
    expect(snapshot.requests[initialHomeId]).toBeUndefined();
    expect(snapshot.runQueue.some((run) => run.threadId === initialHomeId)).toBe(false);
    expect(
      snapshot.machines
        .flatMap((machine) => machine.computerUse?.sessions ?? [])
        .some((session) => session.threadId === initialHomeId),
    ).toBe(false);
    expect(
      Object.values(snapshot.requests)
        .flat()
        .map((request) => request.presentation.title),
    ).toContain("Send the launch email");

    await client.createThread(threadInput(client, workspaceId));
    const taskDefault = structuredClone(client.getSnapshot().executionPreferences.history);
    const homeInput = threadInput(client, workspaceId);
    const home = await client.createHome({
      ...homeInput,
      modelSelection: ModelSelectionSchema.parse({
        ...homeInput.modelSelection,
        options: { effort: "high" },
      }),
    });
    expect(client.getSnapshot().homeThreadId).toBe(home.id);
    expect(
      client.getSnapshot().workspaces.find((workspace) => workspace.id === workspaceId)
        ?.homeThreadId,
    ).toBe(home.id);
    expect(client.getSnapshot().executionPreferences.history).toEqual(taskDefault);

    await client.updateThreadExecution(home.id, {
      harnessInstanceId: home.harnessInstanceId,
      modelSelection: ModelSelectionSchema.parse({
        ...home.modelSelection,
        options: { effort: "low" },
      }),
    });
    expect(client.getSnapshot().executionPreferences.history).toEqual(taskDefault);
    const chatSelection = client
      .getSnapshot()
      .threads.find(({ id }) => id === home.id)?.modelSelection;

    await client.createThread(threadInput(client, workspaceId));
    expect(client.getSnapshot().threads.find(({ id }) => id === home.id)?.modelSelection).toEqual(
      chatSelection,
    );
  });

  it("rebinds a withdrawn queued attachment to a resend in the same Thread", async () => {
    const client = createClient();
    const workspaceId = "wsp_00000000-0000-4000-8000-000000000001";
    const thread = await client.createThread(threadInput(client, workspaceId));
    const first = sendMessage(client, thread.id, "Keep the Run busy");
    const source = new Blob(["photo bytes"], { type: "image/jpeg" });
    const attachment = await client.createAttachment({
      idempotencyKey: `mock-attachment:${crypto.randomUUID()}`,
      mediaType: source.type,
      name: "photo.jpg",
      sizeBytes: source.size,
      workspaceId,
    });
    await client.uploadAttachment({ attachmentId: attachment.id, source });
    const content = [
      {
        artifactId: attachment.id,
        mediaType: source.type,
        name: "photo.jpg",
        sizeBytes: source.size,
        type: "artifact" as const,
      },
    ];
    const queued = await client.dispatch({
      content,
      idempotencyKey: `mock-message:${crypto.randomUUID()}`,
      threadId: thread.id,
      type: "thread.sendMessage",
    });
    if (queued.type !== "thread.sendMessage") throw new Error("Expected a queued send");
    expect(queued.input.state).toBe("pending");
    await client.cancelThreadInput(thread.id, queued.message.id);

    const resent = await client.dispatch({
      content,
      idempotencyKey: `mock-message:${crypto.randomUUID()}`,
      threadId: thread.id,
      type: "thread.sendMessage",
    });
    if (resent.type !== "thread.sendMessage") throw new Error("Expected a resend");
    expect(resent.input.state).toBe("pending");
    expect((await client.getAttachment(attachment.id)).messageId).toBe(resent.message.id);

    const otherThread = await client.createThread(threadInput(client, workspaceId));
    await expect(
      client.dispatch({
        content,
        idempotencyKey: `mock-message:${crypto.randomUUID()}`,
        threadId: otherThread.id,
        type: "thread.sendMessage",
      }),
    ).rejects.toThrow("Attachment is unavailable for this thread.");
    await first;
  });

  it("dispatches thread.input.steer and thread.input.cancel with typed results and refusals", async () => {
    const client = createClient();
    const thread = await client.createThread(
      threadInput(client, "wsp_00000000-0000-4000-8000-000000000001"),
    );
    const first = sendMessage(client, thread.id, "First turn");
    const steered = unwrapSend(await sendMessage(client, thread.id, "Steer this"));
    const withdrawn = unwrapSend(await sendMessage(client, thread.id, "Withdraw this"));
    const steerRunId = (await client.loadThreadInputQueue(thread.id)).steerRunId;
    if (!steerRunId) throw new Error("The running Run should accept steering.");

    const stale = await client.rpc["commands.dispatch"]({
      expectedRunId: "run_00000000-0000-4000-8000-000000000099",
      idempotencyKey: `mock-steer:${crypto.randomUUID()}`,
      messageId: steered.message.id,
      threadId: thread.id,
      type: "thread.input.steer",
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(client.getSnapshot().inputQueues[thread.id]?.items).toHaveLength(2);

    const promoted = hostApi["commands.dispatch"].success.parse(
      unwrap(
        await client.rpc["commands.dispatch"]({
          expectedRunId: steerRunId,
          idempotencyKey: `mock-steer:${crypto.randomUUID()}`,
          messageId: steered.message.id,
          threadId: thread.id,
          type: "thread.input.steer",
        }),
      ),
    );
    expect(promoted).toMatchObject({
      input: { messageId: steered.message.id, runId: steerRunId, state: "claimed" },
      type: "thread.input.steer",
    });

    const cancelled = hostApi["commands.dispatch"].success.parse(
      unwrap(
        await client.rpc["commands.dispatch"]({
          idempotencyKey: `mock-cancel:${crypto.randomUUID()}`,
          messageId: withdrawn.message.id,
          threadId: thread.id,
          type: "thread.input.cancel",
        }),
      ),
    );
    expect(cancelled).toMatchObject({
      input: {
        cancelReason: "withdrawn",
        messageId: withdrawn.message.id,
        runId: null,
        state: "cancelled",
      },
      type: "thread.input.cancel",
    });
    expect(client.getSnapshot().inputQueues[thread.id]).toMatchObject({ items: [] });

    const again = await client.rpc["commands.dispatch"]({
      idempotencyKey: `mock-cancel:${crypto.randomUUID()}`,
      messageId: withdrawn.message.id,
      threadId: thread.id,
      type: "thread.input.cancel",
    });
    expect(again).toMatchObject({ ok: false, error: { code: "conflict" } });
    await first;
  });

  it("seeds integrations that satisfy the Host dashboard contracts", async () => {
    const client = createClient();

    const dashboard = IntegrationDashboardSchema.parse(await integrations(client));
    const platform = IntegrationPlatformDashboardSchema.parse(await integrationPlatform(client));

    expect(platform.catalog.map(({ definition }) => definition.id)).toEqual([
      "apple-contacts",
      "apple-calendar",
      "apple-reminders",
      "iphone-location",
      "iphone-photos",
      "github",
      "google-calendar",
      "linear",
      "notion",
      "apple-messages",
      "macos-app",
      "android-phone",
      "slack",
      "resend",
    ]);
    expect(
      platform.catalog
        .filter(({ installationId }) => installationId === null)
        .map(({ definition }) => definition.id),
    ).toEqual([
      "apple-contacts",
      "apple-calendar",
      "apple-reminders",
      "iphone-location",
      "iphone-photos",
      "resend",
    ]);
    expect(
      platform.installations.filter(({ installation }) => installation.sourceKind === "remote-mcp"),
    ).toHaveLength(1);
    expect(platform.connections.map(({ status }) => status)).toEqual(["connected", "connected"]);
    expect(dashboard.connections.map(({ definitionId, status }) => [definitionId, status])).toEqual(
      [
        ["github", "connected"],
        // One pins an app revision that is gone; two wait for their
        // repositories, and GitHub has revoked the token of the second.
        ["github", "needs-attention"],
        ["github", "needs-attention"],
        ["github", "needs-attention"],
        ["linear", "connected"],
        // Two Macs with Messages are two connections, never one that moves.
        ["apple-messages", "connected"],
        ["apple-messages", "connected"],
        // Computer use is one connection per app, and a blocked app is paused.
        ["macos-app", "connected"],
        ["macos-app", "connected"],
        ["macos-app", "paused"],
        // A phone is one connection for its whole screen.
        ["android-phone", "connected"],
        ["notion", "needs-attention"],
        ["slack", "revoked"],
        // Both Google accounts predate a change to the authorization.
        ["google-calendar", "needs-attention"],
        ["google-calendar", "needs-attention"],
        // An agent-proposed key the service rejected, beside the same-named
        // account an older reconnect made instead of repairing it.
        ["vapi-api", "needs-attention"],
        ["vapi-api", "connected"],
        ["macos-app", "connected"],
      ],
    );
    expect(
      Object.entries(dashboard.providerAuthorizations).map(([provider, { code }]) => [
        provider,
        code,
      ]),
    ).toEqual([
      ["github", "READY"],
      ["google", "READY"],
      ["notion", "ACCOUNT_LINK_REQUIRED"],
      ["slack", "PROVIDER_APPLICATION_REQUIRED"],
    ]);
    expect(dashboard.providerAuthorizations["github"]?.availableSources).toHaveLength(2);
    expect(dashboard.applications.map(({ provider }) => provider)).toEqual(["github"]);
    expect(dashboard.callbackUrls["github"]).toMatch(/\/callback\/github$/);
    expect(
      await integrationGrants(client, "wsp_00000000-0000-4000-8000-000000000002"),
    ).toHaveLength(2);
    expect(
      (await integrationGrants(client, "wsp_00000000-0000-4000-8000-000000000003")).map(
        ({ status }) => status,
      ),
    ).toEqual(["active"]);
  });
  it("keeps every seeded Thread at work holding the Run the Host would, and stops it", async () => {
    const client = createClient();
    try {
      const { runQueue, threads } = client.getSnapshot();
      const atWork = threads.filter(({ status }) => status === "running" || status === "waiting");
      expect(atWork.length).toBeGreaterThan(0);
      for (const thread of atWork) {
        expect(threadStopTarget({ runQueue, thread }), thread.title).not.toBeNull();
      }
      const waiting = atWork.find(({ id }) => id === "thr_00000000-0000-4000-8000-000000000002");
      if (!waiting) throw new Error("The seeded waiting Thread is missing.");
      await client.stopRun(waiting.id);
      const after = client.getSnapshot();
      expect(after.runQueue.some(({ threadId }) => threadId === waiting.id)).toBe(false);
      expect(after.threads.find(({ id }) => id === waiting.id)?.inputQueuePaused).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("records a model switch as the marker the Host's event folds into", async () => {
    const client = createClient();
    try {
      const snapshot = client.getSnapshot();
      const thread = snapshot.threads.find(({ status }) => status === "idle")!;
      const placement = threadPlacementOptions(snapshot.environments, snapshot.harnesses).find(
        (option) => option.harnessInstanceId === thread.harnessInstanceId,
      );
      const model = placement?.models.find(
        (candidate) => candidate.modelId !== thread.modelSelection.modelId,
      );
      if (!model) throw new Error("The mock offers no other model on this account.");
      const updated = await client.updateThreadExecution(thread.id, {
        harnessInstanceId: thread.harnessInstanceId,
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: {},
          providerId: model.providerId,
        }),
      });
      const markers = (client.getSnapshot().transcripts[thread.id] ?? []).filter(
        (entry) => entry.kind === "selection",
      );
      expect(markers).toEqual([
        expect.objectContaining({
          harnessInstanceId: updated.harnessInstanceId,
          modelSelection: updated.modelSelection,
          providerSessionId: updated.providerSessionId,
          runId: null,
        }),
      ]);
    } finally {
      client.dispose();
    }
  });

  it("reports the streams a reply is still writing through the live read", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 40, now: () => fixedNow });
    try {
      const thread = client.getSnapshot().threads.find(({ status }) => status === "idle")!;
      const sending = sendMessage(client, thread.id, "Check the expenses");
      const streaming = () =>
        (client.getSnapshot().transcripts[thread.id] ?? []).find(
          (entry) => entry.kind === "reasoning" && entry.state === "streaming",
        );
      // Advance only to the first emission, then hold domain time during the live read.
      await vi.advanceTimersByTimeAsync(20);
      expect(streaming()).toBeDefined();
      const drawn = streaming();
      if (drawn?.kind !== "reasoning") throw new Error("Nothing is streaming.");
      const live = unwrap(await client.rpc["thread.live.get"]({ threadId: thread.id }));
      expect(live.runs).toEqual([
        expect.objectContaining({
          progress: expect.objectContaining({
            items: [
              {
                blockId: "block-1",
                length: drawn.text.length,
                op: "replace",
                stream: "reasoning",
                text: drawn.text,
              },
            ],
            runId: drawn.runId,
            threadId: thread.id,
          }),
        }),
      ]);
      await vi.runAllTimersAsync();
      await sending;
      expect(unwrap(await client.rpc["thread.live.get"]({ threadId: thread.id })).runs).toEqual([]);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
});

/*
 * The preview Host's Chat, which every client develops against. What can go
 * wrong: a message sent while Opensteer is replying waits in a queue until the
 * reply ends; a message joins a reply that is waiting on an approval, so the
 * person's words stand in for an answer they never gave; Stop pauses Chat and
 * the next Send waits for a Resume nobody offers; a stopped exchange's unsent
 * message reads as sent; a work Thread loses its queue, Steer or pause.
 */
describe("MockHostClient Chat messaging", () => {
  const homeId = "thr_00000000-0000-4000-8000-000000000001";
  const homeRunId = "run_00000000-0000-4000-8000-000000000001";
  const transcript = (client: MockHostClient, threadId = homeId) =>
    client.getSnapshot().transcripts[threadId] ?? [];
  const entry = (client: MockHostClient, id: string, threadId = homeId) =>
    transcript(client, threadId).find((candidate) => candidate.id === id);

  it("joins a message sent while Opensteer is replying to that reply, where it was sent", async () => {
    const client = createClient();
    try {
      // The Host answers a joined send with the Run it joined: steering, not queueing.
      const joined = hostApi["commands.dispatch"].success.parse(
        unwrap(
          await client.rpc["commands.dispatch"]({
            content: [{ text: "Keep it short", type: "text" }],
            idempotencyKey: `mock-message:${crypto.randomUUID()}`,
            threadId: homeId,
            type: "thread.sendMessage",
          }),
        ),
      );
      if (joined.type !== "thread.sendMessage") throw new Error("Command mismatch.");
      expect(joined.input).toMatchObject({ runId: homeRunId, state: "claimed" });
      expect(joined.message.runId).toBe(homeRunId);
      expect(joined.run).toMatchObject({
        id: homeRunId,
        replyTarget: null,
        requestedBy: "usr_0192f4a1-0000-4000-8000-000000000001",
        status: "running",
        threadId: homeId,
      });
      expect(client.getSnapshot().inputQueues[homeId]?.items ?? []).toEqual([]);
      expect(transcript(client).at(-1)).toMatchObject({ id: joined.message.id, runId: homeRunId });
      expect(client.getSnapshot().threads.find(({ id }) => id === homeId)?.inputQueuePaused).toBe(
        false,
      );
    } finally {
      client.dispose();
    }
  });

  it("joins a message to a fresh reply in progress, and the reply takes it in", async () => {
    const client = new MockHostClient({
      initialHome: "absent",
      latencyMs: 0,
      now: () => fixedNow,
    });
    try {
      const home = await client.createThread({
        ...threadInput(client, "wsp_00000000-0000-4000-8000-000000000001"),
        home: true,
      });
      expect(home.role).toBe("conversation");
      const first = sendMessage(client, home.id, "Plan my week");
      const joined = unwrapSend(await sendMessage(client, home.id, "Keep it short"));
      const runId = joined.input.runId;
      expect(joined.input.state).toBe("claimed");
      expect(joined.run).toMatchObject({ id: runId, status: "running", threadId: home.id });
      await first;
      const after = transcript(client, home.id);
      const run = after.find((candidate) => candidate.kind === "run" && candidate.runId === runId);
      expect(run).toMatchObject({ status: "completed" });
      const reply = after.find(
        (candidate) => run?.kind === "run" && candidate.id === run.replyMessageId,
      );
      expect(reply).toMatchObject({ kind: "message", messageKind: "assistant" });
      expect(reply?.kind === "message" ? reply.body : "").toContain("Keep it short");
      // The reply answers both, so it comes after the message that joined it.
      expect(after.findIndex(({ id }) => id === reply?.id)).toBeGreaterThan(
        after.findIndex(({ id }) => id === joined.message.id),
      );
      expect(
        after.filter((candidate) => candidate.kind === "run" && candidate.runId !== null),
      ).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it("holds a message while the reply waits on an approval, and joins it once answered", async () => {
    const approvalId = createId("request");
    const client = new MockHostClient({
      latencyMs: 0,
      now: () => fixedNow,
      pendingRequests: [
        RequestSchema.parse({
          callId: "send-email",
          cancellationReason: null,
          createdAt: fixedNow.toISOString(),
          id: approvalId,
          kind: "harness.approval",
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: homeRunId,
          originatingThreadId: homeId,
          originatingWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
          payload: { kind: "harness.approval" },
          presentation: {
            kind: "choice",
            options: [
              { hint: "allow-once", id: "send", label: "Send" },
              { hint: "reject-once", id: "not-now", label: "Not now" },
            ],
            risk: "medium",
            title: "Send email to Maya?",
          },
          requestedBy: "usr_0192f4a1-0000-4000-8000-000000000001",
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
        }),
      ],
    });
    try {
      const held = unwrapSend(await sendMessage(client, homeId, "Make it friendlier"));
      expect(held.input.state).toBe("pending");
      expect(held.run).toBeNull();
      expect(
        (await client.loadThreadInputQueue(homeId)).items.map(({ message }) => message.id),
      ).toEqual([held.message.id]);
      // The approval is still the person's to answer; the message did not answer it.
      expect(client.getSnapshot().requests[homeId]?.some(({ id }) => id === approvalId)).toBe(true);

      await client.dispatch({
        idempotencyKey: `mock-respond:${crypto.randomUUID()}`,
        requestId: approvalId,
        response: { kind: "choice", optionId: "send" },
        type: "request.respond",
      });
      expect(client.getSnapshot().inputQueues[homeId]?.items ?? []).toEqual([]);
      expect(entry(client, held.message.id)).toMatchObject({ runId: homeRunId });
      const run = entry(client, `run:${homeRunId}`);
      expect(run).toMatchObject({ status: "completed" });
      const ids = transcript(client).map(({ id }) => id);
      expect(ids.indexOf(run?.kind === "run" ? (run.replyMessageId ?? "") : "")).toBeGreaterThan(
        ids.indexOf(held.message.id),
      );
    } finally {
      client.dispose();
    }
  });

  it("ends the reply on Stop without pausing, says what was not sent, and the next Send replies", async () => {
    const client = createClient();
    try {
      const joined = unwrapSend(await sendMessage(client, homeId, "Also check Friday"));
      await client.stopRun(homeId);
      const stopped = client.getSnapshot();
      expect(stopped.threads.find(({ id }) => id === homeId)).toMatchObject({
        inputQueuePaused: false,
        status: "idle",
      });
      expect(stopped.inputQueues[homeId]?.paused ?? false).toBe(false);
      expect(entry(client, `run:${homeRunId}`)).toMatchObject({ status: "interrupted" });
      expect(entry(client, joined.message.id)).toMatchObject({
        delivery: { reason: "Not sent: you stopped the reply.", status: "failed" },
      });

      const next = unwrapSend(await sendMessage(client, homeId, "Just Thursday then"));
      expect(next.run).not.toBeNull();
      const run = entry(client, `run:${next.run?.id}`);
      expect(run).toMatchObject({ status: "completed" });
      expect(entry(client, next.message.id)).not.toHaveProperty("delivery");
    } finally {
      client.dispose();
    }
  });

  it("keeps a work Thread's queue, Steer and the pause a Stop leaves until Resume", async () => {
    const client = createClient();
    try {
      const thread = await client.createThread(
        threadInput(client, "wsp_00000000-0000-4000-8000-000000000001"),
      );
      expect(thread.role).toBe("work");
      const first = sendMessage(client, thread.id, "First turn");
      const queued = unwrapSend(await sendMessage(client, thread.id, "Then this"));
      expect(queued.input.state).toBe("pending");
      expect(queued.run).toBeNull();
      const queue = await client.loadThreadInputQueue(thread.id);
      expect(queue.items.map(({ message }) => message.id)).toEqual([queued.message.id]);
      expect(queue.steerRunId).not.toBeNull();
      expect(queue.items[0]?.canSteer).toBe(true);

      await client.stopRun(thread.id);
      expect(
        client.getSnapshot().threads.find(({ id }) => id === thread.id)?.inputQueuePaused,
      ).toBe(true);
      expect(entry(client, queued.message.id, thread.id)).toBeDefined();
      expect(entry(client, queued.message.id, thread.id)).not.toHaveProperty("delivery");
      await first;
      expect(client.getSnapshot().inputQueues[thread.id]?.items).toHaveLength(1);
      await client.resumeThreadInputQueue(thread.id);
      expect(
        client.getSnapshot().threads.find(({ id }) => id === thread.id)?.inputQueuePaused,
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });
});

it("answers where a phone reaches the preview, the same target a phone enrollment pairs with", async () => {
  const client = createClient();
  const target = unwrap(await client.rpc["agentPhone.target.get"]({}));
  const minted = await client.dispatch({
    idempotencyKey: "mock-phone-target",
    name: "Pixel 7",
    type: "runner.enrollment.createPhone",
  });
  if (minted.type !== "runner.enrollment.createPhone")
    throw new Error("Expected a phone enrollment");
  expect(target).toEqual(minted.pairing);
  expect(new URL(target.hostUrl).protocol).toBe("https:");
  // The phone calls the preview by the name its own Settings show.
  const config = unwrap(await client.rpc["auth.config"]({}));
  expect(target.deploymentName).toBe(config.deployment.name);
});

it("filters the mock task catalog to active listed work before paging", async () => {
  const client = createClient();
  const expected = client
    .getSnapshot()
    .tasks!.entries.filter(
      ({ thread }) => thread.status === "running" || thread.status === "waiting",
    );
  let before: string | undefined;
  const ids: string[] = [];
  do {
    const page = unwrap(
      await client.rpc["tasks.list"]({ active: true, limit: 1, ...(before ? { before } : {}) }),
    );
    expect(page.window.totalItems).toBe(expected.length);
    ids.push(...page.tasks.map(({ thread }) => thread.id));
    before = page.window.nextBefore ?? undefined;
  } while (before);
  expect(ids).toEqual(expected.map(({ thread }) => thread.id));
});

it("models iPhone capability, pairing, pending enrollment, signed approval hooks and removal", async () => {
  const client = createClient();
  try {
    expect(client.getSnapshot().iphoneAppsAvailable).toBe(true);
    const minted = await client.dispatch({
      type: "runner.enrollment.createPhone",
      profile: "iphone",
      idempotencyKey: "mock-iphone",
      name: "Test iPhone",
    });
    if (minted.type !== "runner.enrollment.createPhone") throw new Error("Expected enrollment");
    expect(
      client.getSnapshot().machines.find(({ id }) => id === minted.enrollmentId),
    ).toMatchObject({
      device: { form: "phone", platform: "ios" },
      computerUse: null,
      status: "pending",
    });
    expect(
      await client.dispatch({
        type: "runner.enrollment.createPhone",
        profile: "iphone",
        idempotencyKey: "mock-iphone",
        name: "Test iPhone",
      }),
    ).toEqual(minted);
    await expect(
      client.dispatch({
        type: "runner.enrollment.createPhone",
        idempotencyKey: "mock-iphone",
        name: "Test iPhone",
      }),
    ).rejects.toThrow();
    const runnerId = createId("runner");
    client.mockConnectIphone({ enrollmentId: minted.enrollmentId, runnerId, name: "Test iPhone" });
    const machine = client.getSnapshot().machines.find(({ id }) => id === runnerId)!;
    expect(machine).toMatchObject({
      device: { form: "phone", platform: "ios" },
      computerUse: null,
      status: "online",
    });
    expect(machine.apps?.map(({ definitionId }) => definitionId).sort()).toEqual([
      "apple-calendar",
      "apple-contacts",
      "apple-reminders",
      "iphone-location",
      "iphone-photos",
    ]);
    await client.dispatch({
      type: "integration.computer.approval-key.set",
      idempotencyKey: "iphone-key",
      input: {
        runnerId,
        publicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAERERERERERERERERERERERERERERERERERERERERERE=\n-----END PUBLIC KEY-----\n",
      },
    });
    expect(client.getSnapshot().machines.find(({ id }) => id === runnerId)?.computerUse).toBeNull();
    const request = await client.dispatch({
      type: "integration.computer.setup.request",
      idempotencyKey: "iphone-app",
      input: { kind: "app", app: null, runnerId, definitionId: "apple-calendar", access: "read" },
    });
    if (request.type !== "integration.computer.setup.request") throw new Error("Expected setup");
    await expect(
      client.dispatch({
        type: "integration.computer.setup.set",
        idempotencyKey: "unsigned-iphone",
        input: { kind: "app", app: null, runnerId, definitionId: "apple-calendar", access: "read" },
      }),
    ).rejects.toThrow();
    await client.mockAnswerIphoneApproval({
      setupRequestId: request.request.id,
      decision: "allow",
    });
    const connections = unwrap(await client.rpc["integrations.get"]({})).connections;
    expect(connections.some(({ computer }) => computer?.runnerId === runnerId)).toBe(true);
    await client.dispatch({
      type: "machine.revoke",
      idempotencyKey: "remove-iphone",
      machineId: runnerId,
    });
    expect(client.getSnapshot().machines.some(({ id }) => id === runnerId)).toBe(false);
  } finally {
    client.dispose();
  }
});

describe("shared task Done", () => {
  it("stops work, freezes messages, and reopens without resuming", async () => {
    const client = createClient();
    try {
      const task = await client.createThread(
        threadInput(client, client.getSnapshot().workspaces[0]!.id),
      );
      const done = await client.setTaskDone(task.id, true);
      expect(done.doneAt).toBe(fixedNow.toISOString());
      expect(done.inputQueuePaused).toBe(false);
      await expect(sendMessage(client, task.id, "More work")).rejects.toThrow(
        "This task is Done. Reopen it first.",
      );
      const reopened = await client.setTaskDone(task.id, false);
      expect(reopened.doneAt).toBeNull();
      expect(reopened.status).toBe("idle");
      await expect(sendMessage(client, task.id, "More work")).resolves.toBeDefined();
    } finally {
      client.dispose();
    }
  });

  it("a second client receives absolute Done state and then Reopen", () => {
    const second = createClient();
    try {
      const task = second.getSnapshot().threads.find((thread) => thread.role === "work")!;
      const event = (sequence: string, doneAt: string | null) =>
        AgentEventSchema.parse({
          type: "thread.state-changed",
          eventId: createId("event"),
          threadId: task.id,
          workspaceId: task.workspaceId,
          environmentId: task.environmentId,
          runId: null,
          sequence,
          createdAt: fixedNow.toISOString(),
          data: { status: "idle", inputQueuePaused: false, pendingRequests: 0, doneAt },
        });
      const done = event("100000", fixedNow.toISOString());
      if (done.type !== "thread.state-changed") throw new Error("Wrong event");
      second.applyThreadStateChanged(done);
      expect(second.getSnapshot().threads.find((thread) => thread.id === task.id)?.doneAt).toBe(
        fixedNow.toISOString(),
      );
      const reopen = event("100001", null);
      if (reopen.type !== "thread.state-changed") throw new Error("Wrong event");
      second.applyThreadStateChanged(reopen);
      expect(
        second.getSnapshot().threads.find((thread) => thread.id === task.id)?.doneAt,
      ).toBeNull();
    } finally {
      second.dispose();
    }
  });
});
