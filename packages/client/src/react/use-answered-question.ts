import { answeredQuestion, type AnsweredQuestion } from "@opensteer/core";
import { useCallback, useState } from "react";
import type { HostClient } from "../host/client.js";
import { useHostRead } from "./use-host-read.js";

/**
 * Where an answered question's whole record stands: the thread's copy alone,
 * being read, read whole, gone from the Host, or not read.
 */
export type AnsweredQuestionRead = "preview" | "loading" | "whole" | "unavailable" | "failed";

/**
 * An answered question as its thread row shows it: the record the thread
 * carries, read whole from its Request once the reader opens one cut to fit.
 */
export function useAnsweredQuestion(input: {
  readonly client: HostClient | null;
  readonly threadId: string | null;
  readonly requestId: string;
  readonly question: AnsweredQuestion;
  readonly open: boolean;
}): {
  readonly question: AnsweredQuestion;
  readonly read: AnsweredQuestionRead;
  readonly reload: () => void;
} {
  const { client, threadId, requestId, question, open } = input;
  // Once opened, the whole record stays read, so folding it again costs no new read.
  const [asked, setAsked] = useState(false);
  if (open && !asked) setAsked(true);
  const reads = asked && question.truncated === true && client !== null && threadId !== null;
  const load = useCallback(async () => {
    const request = await client!.readRequest(threadId!, requestId);
    return request ? answeredQuestion(request) : null;
  }, [client, threadId, requestId]);
  const whole = useHostRead(reads ? load : null, JSON.stringify([threadId, requestId]), client);
  const read: AnsweredQuestionRead = !reads
    ? "preview"
    : whole.status === "ready"
      ? whole.data
        ? "whole"
        : "unavailable"
      : whole.status === "failed"
        ? "failed"
        : "loading";
  return {
    question: open && read === "whole" ? whole.data! : question,
    read,
    reload: whole.reload,
  };
}
