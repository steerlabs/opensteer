import { createId, WaitingRequestSchema } from "@opensteer/core";
import { expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  requestsWaitingOn,
  waitingRequestPresentationSource,
  waitingRequestSource,
  threadsWaitingOnReader,
} from "./waiting-requests.js";

it("docks a managed Request on Chat using authorized presentation metadata and retains the worker's answer authority", () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const seed = Object.values(client.getSnapshot().requests)
      .flat()
      .find(({ status }) => status === "pending")!;
    const workerId = createId("thread");
    const chatId = createId("thread");
    const entry = WaitingRequestSchema.parse({
      assignments: [],
      request: { ...seed, originatingThreadId: workerId },
      presentation: {
        threadId: chatId,
        workerThread: { id: workerId, title: "Memory nightly pass" },
      },
    });
    expect(requestsWaitingOn([entry], chatId)).toEqual([entry]);
    expect(requestsWaitingOn([entry], workerId)).toEqual([entry]);
    expect(requestsWaitingOn([entry], createId("thread"))).toEqual([]);
    expect(waitingRequestPresentationSource(entry, chatId)).toEqual({
      id: workerId,
      title: "Memory nightly pass",
    });
    expect(waitingRequestPresentationSource(entry, workerId)).toBeNull();
    expect(waitingRequestSource(entry, chatId)).toBeNull();
    expect(entry.request.originatingThreadId).toBe(workerId);
    expect(threadsWaitingOnReader([entry])).toEqual(new Set([chatId, workerId]));
  } finally {
    client.dispose();
  }
});
