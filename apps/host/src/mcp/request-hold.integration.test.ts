import { createId, type RequestId } from "@opensteer/core";
import {
  describeStore,
  pendingEvent,
  liveRequest,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, vi } from "vitest";
import { ContinuationService } from "../agents/continuation-service.js";
import type { RunCaller } from "./agent-caller.js";
import { RequestHold } from "./request-hold.js";

async function setup(
  storeFixture: StoreFixture,
  suffix: string,
  workspaceKind: "main" | "project" = "main",
) {
  const { store, database } = storeFixture;
  const fixture = await storeFixture.startRunFixture(suffix, workspaceKind);
  const claims = (await store.runCapabilityScope(fixture.run.id))!;
  const opened = await store.requests.create({
    callId: "held",
    kind: "browser.access",
    mode: "durable",
    originatingRunId: fixture.run.id,
    originatingThreadId: fixture.thread.id,
    originatingWorkspaceId: fixture.workspace.id,
    targetWorkspaceId: fixture.workspace.id,
    requestedBy: fixture.userId,
    requiredActor: "requester",
    payload: { kind: "browser.access", reason: "Read mail", suggestion: { kind: "user_choice" } },
    presentation: {
      kind: "external",
      title: "Choose a profile",
      subject: { kind: "workspace", id: fixture.workspace.id },
    },
  });
  const continuations = new ContinuationService({
    requests: store.requests,
    commands: { enqueueThreadInput: (input) => store.enqueueThreadInput(input) },
    integrations: {
      listDiscoveryInventory: async () => [],
      listCallableTools: async () => [],
      computerUseMachines: async () => [],
      computerUsePhones: async () => [],
    },
    onError: (error) => {
      throw error;
    },
  });
  const controller = new AbortController();
  const stopped = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  const hold = new RequestHold({
    store: {
      ...store,
      stopHeldRun: (scope, reason) => store.stopHeldRun(scope, reason),
      requests: {
        markToolDelivered: (id, scope) => store.requests.markToolDelivered(id, scope),
        personSteerCount: (id) => store.requests.personSteerCount(id),
        holdSnapshot: async (...args) => {
          const snapshot = await store.requests.holdSnapshot(...args);
          read.resolve();
          return snapshot;
        },
      },
    },
    continuations,
    onError: (error) => {
      throw error;
    },
    onStopped: () => {
      stopped.resolve();
      controller.abort(new Error("Run stopped"));
    },
  });
  const input = {
    caller: { claims } as RunCaller,
    result: { requestId: opened.request.id, status: "pending" },
    tool: "browser_profile_request",
    admittedAt: Date.now(),
    steersAtAdmission: 0,
    limitMs: 45_000,
    signal: controller.signal,
  };
  const answer = (id: RequestId = opened.request.id) =>
    store.requests.resolveBrowserRequest({
      requestId: id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
  const emit = async (type: "run.completed" | "run.interrupted" | "run.phase", data: object) => {
    const run = await database
      .selectFrom("runs")
      .select("nextRunnerOrdinal")
      .where("id", "=", fixture.run.id)
      .executeTakeFirstOrThrow();
    return store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      runnerId: fixture.runnerId,
      runnerBootId: fixture.runnerBootId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        environmentId: fixture.environmentId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
        ordinal: run.nextRunnerOrdinal,
        type,
        data,
      } as Parameters<typeof pendingEvent>[0]),
    });
  };
  const drain = async () => {
    continuations.notify();
    await continuations.close();
  };
  const wakes = () =>
    database
      .selectFrom("threadInputs")
      .select("messageId")
      .where("authoritySource", "@>", {
        kind: "platform",
        cause: "request-resolved",
        sourceRunId: fixture.run.id,
      })
      .execute();
  return {
    ...fixture,
    store,
    database,
    claims,
    request: opened.request,
    controller,
    stopped,
    read,
    hold,
    input,
    answer,
    emit,
    drain,
    wakes,
    continuations,
  };
}

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return withTimeout(promise, 3000, { timeoutError: () => new Error(message) });
}

describeStore("Held Request lifecycle", (it) => {
  for (const aborted of [false, true]) {
    it(`delivers ${aborted ? "one fallback after abort" : "the answer in the call with no wake-up"}`, async ({
      storeFixture,
    }) => {
      const f = await setup(storeFixture, `inline-${aborted}`);
      const call = f.hold.wait(f.input);
      void call.catch(() => undefined);
      try {
        await deadline(f.read.promise, "Hold never read its Request");
        if (aborted) {
          f.controller.abort(new Error("disconnected"));
          await expect(call).rejects.toThrow("disconnected");
        }
        await f.answer();
        if (!aborted)
          expect(await deadline(call, "Answer never reached the held call")).toMatchObject({
            record: { status: "declined" },
          });
        await f.emit("run.completed", { status: "completed" });
        await f.drain();
        expect(await f.wakes()).toHaveLength(aborted ? 1 : 0);
      } finally {
        f.controller.abort();
        await Promise.allSettled([call]);
        await f.continuations.close();
      }
    });
  }

  it("keeps holding while a parallel live Request makes the Run waiting", async ({
    storeFixture,
  }) => {
    const f = await setup(storeFixture, "parallel-live-request");
    const call = f.hold.wait(f.input);
    void call.catch(() => undefined);
    try {
      await deadline(f.read.promise, "Hold never read its Request");
      await f.store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        event: pendingEvent({
          bindingGeneration: f.bindingGeneration,
          environmentId: f.environmentId,
          runId: f.run.id,
          threadId: f.thread.id,
          workspaceId: f.workspace.id,
          ordinal: 1,
          type: "request.opened",
          data: {
            request: liveRequest({
              id: createId("request"),
              harnessInstanceId: f.harnessInstance.id,
              requestedBy: f.userId,
              runId: f.run.id,
              threadId: f.thread.id,
              workspaceId: f.workspace.id,
              presentation: {
                kind: "choice",
                title: "Native question",
                options: [{ id: "allow", label: "Allow", hint: "confirm" }],
              },
            }),
          },
        }),
      });
      expect(
        await f.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", f.run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "waiting" });
      await f.answer();
      expect(
        await deadline(call, "Parallel live Request released or blocked the durable hold"),
      ).toMatchObject({ record: { status: "declined" } });
      expect(
        await f.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", f.run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "waiting" });
    } finally {
      f.controller.abort();
      await Promise.allSettled([call]);
      await f.continuations.close();
    }
  });

  it("serializes inline delivery against finalization", async ({ storeFixture }) => {
    const f = await setup(storeFixture, "mark-finalize");
    try {
      await f.answer();
      const [marked] = await deadline(
        Promise.all([
          f.store.requests.markToolDelivered(f.request.id, f.claims),
          f.emit("run.completed", { status: "completed" }),
        ]),
        "Mark and finalization did not finish",
      );
      await f.drain();
      expect(await f.wakes()).toHaveLength(marked === "refused" ? 1 : 0);
    } finally {
      await f.continuations.close();
    }
  });

  it("refuses marking after a background flip while the live drain renders", async ({
    storeFixture,
  }) => {
    const f = await setup(storeFixture, "mark-background");
    const rendering = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const outcome = f.continuations.outcome.bind(f.continuations);
    vi.spyOn(f.continuations, "outcome").mockImplementation(async (request) => {
      rendering.resolve();
      await deadline(release.promise, "Drain render was never released");
      return outcome(request);
    });
    try {
      await f.answer();
      await f.emit("run.phase", { phase: "background" });
      f.continuations.notify();
      await deadline(rendering.promise, "Live continuation drain never rendered");
      expect(await f.store.requests.markToolDelivered(f.request.id, f.claims)).toBe("refused");
      release.resolve();
      await f.drain();
      expect(await f.wakes()).toHaveLength(1);
    } finally {
      release.resolve();
      await f.continuations.close();
    }
  });

  for (const kind of ["limit", "queued"] as const) {
    it(`stops for ${kind}, preserves the open Request and allows its later wake-up`, async ({
      storeFixture,
    }) => {
      const f = await setup(storeFixture, `stop-${kind}`, kind === "queued" ? "project" : "main");
      if (kind === "limit") f.input.admittedAt -= f.input.limitMs;
      else
        await f.store.enqueueThreadInput({
          content: [{ type: "text", text: "Do this next" }],
          idempotencyKey: "queued-person",
          policy: "queue",
          requestedBy: f.userId,
          source: { kind: "human" },
          threadId: f.thread.id,
        });
      const call = f.hold.wait(f.input);
      void call.catch(() => undefined);
      try {
        await deadline(f.stopped.promise, "Held Run never stopped");
        await expect(call).rejects.toThrow("Run stopped");
        expect((await f.store.requests.get(f.request.id))?.status).toBe("pending");
        expect(
          await f.database
            .selectFrom("threads")
            .select("inputQueuePaused")
            .where("id", "=", f.thread.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ inputQueuePaused: false });
        await f.emit("run.interrupted", { status: "interrupted" });
        await f.answer();
        await f.drain();
        expect(await f.wakes()).toHaveLength(1);
      } finally {
        f.controller.abort();
        await Promise.allSettled([call]);
        await f.continuations.close();
      }
    });
  }
});
