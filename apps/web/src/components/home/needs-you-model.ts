import { useState } from "react";
import type { NeedsYouPage } from "@opensteer/protocol";
import {
  mutationIdempotencyKey,
  threadMark,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import type { NeedsYouItemView, TaskSourceView } from "./home-models.js";

type Entry = NeedsYouPage["entries"][number];

/** Choices answer in place when there are few; anything else opens its task. */
function answerOf(entry: Entry): NeedsYouItemView["answer"] {
  const presentation = entry.request.presentation;
  if (presentation.kind === "choice" && presentation.options.length <= 3)
    return {
      kind: "choices",
      options: presentation.options.map((option) => ({ id: option.id, label: option.label })),
    };
  return { kind: "open" };
}

export function needsYouItems(
  snapshot: HostSnapshot,
  sourceOf: (taskId: string) => TaskSourceView | null,
): NeedsYouItemView[] {
  return (snapshot.needsYou?.entries ?? []).map((entry) => {
    const thread = snapshot.threads.find((candidate) => candidate.id === entry.navigationThreadId);
    const source = sourceOf(entry.navigationThreadId);
    const presentation = entry.request.presentation;
    return {
      id: entry.request.id,
      taskId: entry.navigationThreadId,
      taskTitle: entry.title,
      mark: threadMark(entry.navigationThreadId, snapshot),
      where: source
        ? { kind: "team", source }
        : {
            kind: "folder",
            label: thread?.folder.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Agent home",
          },
      askedAt: entry.request.createdAt,
      title: presentation.title,
      detail: presentation.detail ?? null,
      channelSees: source ? "Waiting for you" : null,
      answer: answerOf(entry),
    };
  });
}

/** One answer at a time, from a card; a refusal is reported and the card stays. */
export function useNeedsYouAnswer(
  hostClient: HostClient,
  report: (error: unknown) => void,
): {
  readonly pending: string | null;
  readonly answer: (requestId: string, optionId: string) => void;
} {
  const [pending, setPending] = useState<string | null>(null);
  return {
    pending,
    answer: (requestId, optionId) => {
      if (pending) return;
      setPending(requestId);
      void hostClient
        .dispatch({
          idempotencyKey: mutationIdempotencyKey(`request:${requestId}`),
          requestId,
          response: { kind: "choice", optionId },
          type: "request.respond",
        })
        .catch(report)
        .finally(() => setPending(null));
    },
  };
}
