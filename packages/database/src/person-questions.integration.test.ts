import { createId, type RequestPresentation } from "@opensteer/core";
import { expect } from "vitest";
import { needsYouPage } from "./needs-you-store.js";
import { readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";
import {
  describeStore,
  pendingEvent,
  type StoreFixture,
} from "./store.integration.test-support.js";

type Started = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;

const presentation = {
  kind: "form",
  title: "Reply to Sarah?",
  detail: "Draft: Jan 15 works.",
  fields: [
    {
      choices: [
        { label: "Send it", value: "Send it" },
        { label: "Not yet", value: "Not yet" },
      ],
      custom: true,
      id: "question_1",
      multiSelect: false,
      prompt: "Send this reply?",
      secret: false,
    },
  ],
} satisfies RequestPresentation;

function ask(f: StoreFixture, run: Started, callId: string, title = presentation.title) {
  return f.store.requests.create({
    callId,
    kind: "person.question",
    mode: "durable",
    originatingRunId: run.run.id,
    originatingThreadId: run.thread.id,
    payload: { kind: "person.question" },
    presentation: { ...presentation, title },
    requestedBy: run.userId,
    requiredActor: "requester",
  });
}

async function finish(f: StoreFixture, run: Started) {
  const row = await f.database
    .selectFrom("runs")
    .select("nextRunnerOrdinal")
    .where("id", "=", run.run.id)
    .executeTakeFirstOrThrow();
  await f.store.commitRunnerEvent({
    environmentId: run.environmentId,
    runnerId: run.runnerId,
    runnerBootId: run.runnerBootId,
    event: pendingEvent({
      bindingGeneration: run.bindingGeneration,
      environmentId: run.environmentId,
      runId: run.run.id,
      threadId: run.thread.id,
      ordinal: row.nextRunnerOrdinal,
      type: "run.completed",
      data: { status: "completed" },
    }),
  });
}

/** The question as its thread keeps it once settled: the record clients draw. */
async function threadRecord(f: StoreFixture, run: Started, requestId: string) {
  const read = await readTranscriptItem(f.database, {
    viewerId: run.userId,
    scope: { kind: "thread", threadId: run.thread.id },
    itemId: `request:${requestId}`,
  });
  return read.kind === "item" ? read.item : null;
}

async function continuations(f: StoreFixture) {
  return f.database.selectFrom("requestContinuations").select("requestId").execute();
}

describeStore("person questions", (it) => {
  it("raises one card for the same pending question, however many Runs ask it", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("person-question-dedupe");
    const first = await ask(f, run, "first");
    expect(first.request).toMatchObject({ kind: "person.question", mode: "durable" });
    expect((await ask(f, run, "again")).request.id).toBe(first.request.id);
    expect((await ask(f, run, "other", "Archive the thread?")).request.id).not.toBe(
      first.request.id,
    );
    const page = await needsYouPage(f.database, { userId: run.userId });
    expect(page.entries.map((entry) => entry.kind === "request" && entry.request.id)).toContain(
      first.request.id,
    );
  });

  it("takes only the asked person's answer, only once, and wakes the task with it", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("person-question-answer");
    const { request } = await ask(f, run, "ask");
    const answer = (answers: Record<string, string[]>) => ({ kind: "form" as const, answers });
    await expect(
      f.store.requests.answerPersonQuestion({
        requestId: request.id,
        expectedRevision: (await f.store.requests.revision(request.id))!,
        resolvedBy: createId("user"),
        response: answer({ question_1: ["Send it"] }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.store.requests.answerPersonQuestion({
        requestId: request.id,
        expectedRevision: (await f.store.requests.revision(request.id))!,
        resolvedBy: run.userId,
        response: answer({ question_1: ["Send it", "Not yet"] }),
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await continuations(f)).toEqual([]);

    const revision = (await f.store.requests.revision(request.id))!;
    await expect(
      f.store.requests.answerPersonQuestion({
        requestId: request.id,
        expectedRevision: (BigInt(revision) + 1n).toString(),
        resolvedBy: run.userId,
        response: answer({ question_1: ["Send it"] }),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await continuations(f)).toEqual([]);

    const settled = await f.store.requests.answerPersonQuestion({
      requestId: request.id,
      expectedRevision: (await f.store.requests.revision(request.id))!,
      resolvedBy: run.userId,
      response: answer({ question_1: ["Wait until Friday"] }),
    });
    expect(settled.request).toMatchObject({
      status: "fulfilled",
      response: answer({ question_1: ["Wait until Friday"] }),
    });
    const settledRevision = (await f.store.requests.revision(request.id))!;
    expect(BigInt(settledRevision)).toBeGreaterThan(BigInt(revision));
    expect(
      await f.database
        .selectFrom("clientChanges")
        .select(["entityKind", "operation"])
        .where("sequence", "=", settledRevision)
        .where("entityId", "=", request.id)
        .execute(),
    ).toEqual([{ entityKind: "request", operation: "remove" }]);
    expect(
      await f.database
        .selectFrom("clientSyncState")
        .select("pendingRequestCount")
        .executeTakeFirstOrThrow(),
    ).toEqual({ pendingRequestCount: 0 });
    expect(await continuations(f)).toEqual([{ requestId: request.id }]);
    expect(await threadRecord(f, run, request.id)).toMatchObject({
      kind: "request",
      question: {
        outcome: "answered",
        detail: presentation.detail,
        answers: [{ prompt: "Send this reply?", answer: ["Wait until Friday"] }],
      },
    });
    await expect(
      f.store.requests.answerPersonQuestion({
        requestId: request.id,
        expectedRevision: (await f.store.requests.revision(request.id))!,
        resolvedBy: run.userId,
        response: answer({ question_1: ["Send it"] }),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("settles a question as long as an ask allows, and draws it cut to fit", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("person-question-long");
    const detail = `\`\`\`draft\n${"Long draft words. ".repeat(1_200)}`.slice(0, 20_000);
    const { request } = await f.store.requests.create({
      callId: "long",
      kind: "person.question",
      mode: "durable",
      originatingRunId: run.run.id,
      originatingThreadId: run.thread.id,
      payload: { kind: "person.question" },
      presentation: { ...presentation, detail },
      requestedBy: run.userId,
      requiredActor: "requester",
    });
    const typed = "Rewrite it shorter. ".repeat(200);
    const settled = await f.store.requests.answerPersonQuestion({
      requestId: request.id,
      expectedRevision: (await f.store.requests.revision(request.id))!,
      resolvedBy: run.userId,
      response: { kind: "form", answers: { question_1: [typed] } },
    });
    expect(settled.request.status).toBe("fulfilled");

    const record = await threadRecord(f, run, request.id);
    const question = record?.kind === "request" ? record.question : undefined;
    expect(question).toMatchObject({ outcome: "answered", truncated: true });
    expect(detail.startsWith(question!.detail!)).toBe(true);
    expect(typed.startsWith(question!.answers[0]!.answer[0]!)).toBe(true);

    // The settlement reached attached devices as the record, not as a reset.
    const change = await f.database
      .selectFrom("clientChanges")
      .select(["operation", "payload", "byteCount"])
      .where("entityKind", "=", "item")
      .where("entityId", "=", `request:${request.id}`)
      .executeTakeFirstOrThrow();
    expect(change.operation).toBe("upsert");
    expect(change.payload).toMatchObject({ kind: "request", question: { truncated: true } });
    expect(change.byteCount).toBeLessThanOrEqual(8192);

    const page = await readTranscriptPage(f.database, {
      viewerId: run.userId,
      scope: { kind: "thread", threadId: run.thread.id },
      limit: 100,
    });
    // Drawn from the full Request when settled and from its read facts since: the same record.
    expect(page.kind === "page" && page.items.find(({ id }) => id === record!.id)).toMatchObject({
      question: (change.payload as { question: unknown }).question,
    });
  });

  it("takes Dismiss as a decline the task hears about", async ({ storeFixture: f }) => {
    const run = await f.startRunFixture("person-question-dismiss");
    const { request } = await ask(f, run, "ask");
    await expect(
      f.store.requests.answerPersonQuestion({
        requestId: request.id,
        expectedRevision: (await f.store.requests.revision(request.id))!,
        resolvedBy: run.userId,
        response: { kind: "external", value: { decision: "fulfilled" } },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const dismissed = await f.store.requests.answerPersonQuestion({
      requestId: request.id,
      expectedRevision: (await f.store.requests.revision(request.id))!,
      resolvedBy: run.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(dismissed.request.status).toBe("declined");
    expect(await continuations(f)).toEqual([{ requestId: request.id }]);
    expect(await threadRecord(f, run, request.id)).toMatchObject({
      question: {
        outcome: "dismissed",
        detail: presentation.detail,
        answers: [{ prompt: "Send this reply?", answer: [] }],
      },
    });
  });

  it("wakes the task with one answer while the agent's other question still waits", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("person-question-siblings");
    const first = await ask(f, run, "first");
    await ask(f, run, "second", "Archive the old invoices?");
    await finish(f, run);
    await f.store.requests.answerPersonQuestion({
      requestId: first.request.id,
      expectedRevision: (await f.store.requests.revision(first.request.id))!,
      resolvedBy: run.userId,
      response: { kind: "form", answers: { question_1: ["Send it"] } },
    });
    expect(
      (await f.store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toEqual([first.request.id]);
  });
});
