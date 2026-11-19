import { answeredQuestion, type AnsweredQuestion } from "@opensteer/core";
import { useCallback } from "react";
import type { HostClient } from "../host/client.js";
import { useHostRead } from "./use-host-read.js";

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
}) {
  const { client, threadId, requestId, question, open } = input;
  const read = useCallback(async () => {
    const request = await client!.readRequest(threadId!, requestId);
    return request ? answeredQuestion(request) : null;
  }, [client, threadId, requestId]);
  const whole = useHostRead(
    open && question.truncated === true && client !== null && threadId !== null ? read : null,
    JSON.stringify([threadId, requestId]),
    client,
  );
  return {
    question: whole.data ?? question,
    loading: whole.loading,
    error: whole.error,
    reload: whole.reload,
  };
}
