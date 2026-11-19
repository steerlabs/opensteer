// @vitest-environment happy-dom
import type { AnsweredQuestionEntry, HostClient } from "@opensteer/client/host";
import { controlledClientSession } from "@opensteer/client/test-support";
import { RequestSchema, createId, type Request } from "@opensteer/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AnsweredQuestionRow } from "./answered-question.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const typed = "Rewrite it shorter, and mention the Boston pilot. ".repeat(80);
const threadId = createId("thread");
const requestId = createId("request");

function answered(): Request {
  const userId = createId("user");
  return RequestSchema.parse({
    callId: "ask",
    cancellationReason: null,
    createdAt: "2026-11-19T21:01:05.000Z",
    id: requestId,
    kind: "person.question",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: threadId,
    payload: { kind: "person.question" },
    presentation: {
      kind: "form",
      title: "How should I change the DM?",
      fields: [
        {
          custom: true,
          id: "question_1",
          multiSelect: false,
          prompt: "How should I change the DM?",
          secret: false,
        },
      ],
    },
    requestedBy: userId,
    requiredActor: "requester",
    resolvedAt: "2026-11-19T22:30:00.000Z",
    resolvedBy: userId,
    response: { kind: "form", answers: { question_1: [typed] } },
    status: "fulfilled",
  });
}

const entry: AnsweredQuestionEntry = {
  createdAt: "2026-11-19T22:30:00.000Z",
  id: `request:${requestId}`,
  kind: "request",
  outcome: "Fulfilled · Answered",
  question: {
    outcome: "answered",
    answers: [{ prompt: "How should I change the DM?", answer: [typed.slice(0, 400)] }],
    truncated: true,
  },
  requestId,
  requestKind: "person.question",
  runId: null,
  title: "How should I change the DM?",
};

function render(readRequest: HostClient["readRequest"]) {
  const client = {
    connection: controlledClientSession().connection,
    readRequest,
  } as unknown as HostClient;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  act(() => root.render(<AnsweredQuestionRow client={client} entry={entry} threadId={threadId} />));
  const toggle = () => {
    const button = [...node.querySelectorAll("button")].find((each) =>
      /Show (more|less)/u.test(each.textContent ?? ""),
    );
    if (!button) throw new Error("The record offers no Show more");
    act(() => button.click());
  };
  return { node, toggle };
}

it("opens an answer cut to fit to the whole of it, and folds it again", async () => {
  const readRequest = vi.fn(async () => answered());
  const { node, toggle } = render(readRequest);
  const words = () => node.querySelector(".answered-question__words")?.textContent ?? "";
  expect(words()).toBe(typed.slice(0, 400));

  toggle();
  await vi.waitFor(
    () => expect(words().trim(), "the whole answer never arrived").toBe(typed.trim()),
    {
      timeout: 2_000,
    },
  );
  expect(readRequest).toHaveBeenCalledWith(threadId, requestId);

  toggle();
  expect(words()).toBe(typed.slice(0, 400));
});

it("says so when the whole question is gone, keeping what the thread has", async () => {
  const { node, toggle } = render(vi.fn(async () => null));
  toggle();
  await vi.waitFor(
    () =>
      expect(node.textContent, "the record never said it was gone").toContain(
        "The whole question is no longer available.",
      ),
    { timeout: 2_000 },
  );
  expect(node.querySelector(".answered-question__words")?.textContent).toBe(typed.slice(0, 400));
});
