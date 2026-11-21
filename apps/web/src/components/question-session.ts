import { requestDecision } from "@opensteer/client/host";
import { outcomeWords, requestAnswer, runAction } from "./use-action.js";
import {
  mutationIdempotencyKey,
  questionStep,
  type HostClient,
  type QuestionDrafts,
  type RequestView,
} from "@opensteer/client/host";
import type { RequestResponse } from "@opensteer/core";
import { useSyncExternalStore } from "react";
import { composerDraftKeyFor, composerDrafts, holdsContent } from "./composer-drafts.js";
import { useShell } from "./app-shell.js";

/**
 * What a person has started answering of one question, shared by the card that
 * shows its options and the composer that takes its typed answer, wherever on
 * the page each is drawn. It lives for the window, so leaving the task and
 * coming back finds the answer where it was left.
 */
export interface QuestionSession {
  readonly drafts: QuestionDrafts;
  readonly index: number;
  /** The person chose to type an answer while their message draft waited. */
  readonly typing: boolean;
  readonly sending: boolean;
  readonly failure: string | null;
  /** The last answer that didn't settle: a retry of the same answer is the same command. */
  readonly held: { readonly key: string; readonly response: string } | null;
}

const fresh: QuestionSession = Object.freeze({
  drafts: {},
  failure: null,
  held: null,
  index: 0,
  sending: false,
  typing: false,
});
const sessions = new Map<string, QuestionSession>();
const listeners = new Set<() => void>();

export function useQuestionSessionKey(request: RequestView | null): string | null {
  const { snapshot } = useShell();
  return (
    request &&
    JSON.stringify([snapshot.deploymentId, snapshot.user?.id, request.id, request.reviewedRevision])
  );
}

function read(key: string | null): QuestionSession {
  return (key === null ? undefined : sessions.get(key)) ?? fresh;
}

export function updateQuestionSession(key: string | null, change: Partial<QuestionSession>): void {
  if (key === null) return;
  sessions.set(key, { ...read(key), ...change });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useQuestionSession(key: string | null): QuestionSession {
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => read(key),
  );
}

/** Test seam: forget every session between cases. */
export function resetQuestionSessionsForTests(): void {
  sessions.clear();
}

async function respond(
  hostClient: Pick<HostClient, "connection" | "dispatch">,
  request: RequestView,
  sessionKey: string | null,
  response: RequestResponse,
): Promise<void> {
  if (sessionKey === null) return;
  const session = read(sessionKey);
  if (session.sending) return;
  const signature = JSON.stringify(response);
  const key =
    session.held?.response === signature
      ? session.held.key
      : mutationIdempotencyKey(`request:${request.id}`);
  updateQuestionSession(sessionKey, {
    failure: null,
    held: { key, response: signature },
    sending: true,
  });
  const outcome = await runAction(hostClient, {
    ...requestAnswer,
    execute: () =>
      hostClient.dispatch({
        idempotencyKey: key,
        ...requestDecision(request),
        response,
        type: "request.respond",
      }),
  });
  if (outcome.kind === "confirmed") {
    sessions.delete(sessionKey);
    for (const listener of listeners) listener();
    return;
  }
  updateQuestionSession(sessionKey, { failure: outcomeWords(outcome), sending: false });
}

/** Dismissing an agent's question tells it no. Only `ask_person` questions can be dismissed. */
export function dismissQuestion(
  hostClient: Pick<HostClient, "connection" | "dispatch">,
  request: RequestView,
  sessionKey: string | null,
): Promise<void> {
  return respond(hostClient, request, sessionKey, {
    kind: "external",
    value: { decision: "declined" },
  });
}

/**
 * Answering moves on from the question at `index`: to the next one waiting, or
 * the whole form is sent once each has its answer.
 */
export function advanceQuestion(
  hostClient: Pick<HostClient, "connection" | "dispatch">,
  request: RequestView,
  sessionKey: string | null,
  drafts: QuestionDrafts,
  index: number,
): void {
  if (request.presentation.kind !== "form") return;
  const step = questionStep(request.presentation.fields, drafts, index);
  if (step.kind === "next") updateQuestionSession(sessionKey, { drafts, index: step.index });
  else if (step.kind === "send") {
    updateQuestionSession(sessionKey, { drafts });
    void respond(hostClient, request, sessionKey, { answers: step.answers, kind: "form" });
  } else updateQuestionSession(sessionKey, { drafts });
}

/** Whether the person has anything waiting in this task's message box. */
export function useMessageDraftWaiting(threadId: string): boolean {
  const { snapshot } = useShell();
  const key = composerDraftKeyFor(snapshot.deploymentId, snapshot.user?.id ?? null, {
    kind: "thread",
    threadId,
  });
  return useSyncExternalStore(
    composerDrafts.subscribe,
    () => {
      const draft = key ? composerDrafts.read(key) : null;
      return draft !== null && holdsContent(draft);
    },
    () => false,
  );
}

/**
 * Whether the composer is this question's answer right now. A question that
 * arrives while words wait in the message box leaves them there: the card
 * offers to switch, and the box turns into the answer once it's empty.
 */
export function useAnswersInComposer(threadId: string, questionKey: string | null): boolean {
  const waiting = useMessageDraftWaiting(threadId);
  const session = useQuestionSession(questionKey);
  return questionKey !== null && (!waiting || session.typing);
}
