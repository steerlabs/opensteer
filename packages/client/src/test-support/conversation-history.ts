import { createId } from "@opensteer/core";
import { hostApi } from "@opensteer/protocol";
import { HttpHostClient } from "../host/host-session-client.js";
import type { MockHostClient } from "../mock/mock-host-client.js";

/** A filtered Home page whose snapshot covers hundreds of omitted automatic Runs. */
export function conversationHistoryHost(source: MockHostClient) {
  const requests: unknown[] = [];
  const client = new HttpHostClient({
    baseUrl: "http://mock-host",
    capabilities: ["history-turns-v1", "history-conversation-v1"],
    refreshIntervalMs: 0,
    webSocketFactory: () => ({
      binaryType: "arraybuffer",
      readyState: 0,
      addEventListener() {},
      close() {},
      send() {},
    }),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const name = url.pathname.slice("/v1/rpc/".length) as keyof typeof hostApi;
      const raw = url.searchParams.get("input") ?? init?.body;
      const payload = hostApi[name].payload.parse(typeof raw === "string" ? JSON.parse(raw) : {});
      const result = await source.rpc[name](payload as never);
      if (name !== "thread.events.list" || !result.ok) return Response.json(result);
      requests.push(payload);
      const page = hostApi["thread.events.list"].success.parse(result.data);
      const viewer = source.getSnapshot().user!;
      const events = Array.from({ length: 10 }, (_, index) => ({
        createdAt: "2026-10-30T12:00:00.000Z",
        environmentId: page.thread.environmentId,
        eventId: createId("event"),
        runId: null,
        sequence: String(index + 1),
        threadId: page.threadId,
        workspaceId: page.thread.workspaceId,
        type: "message.created",
        data: {
          input: null,
          message: {
            author: {
              kind: "human",
              displayName: viewer.displayName,
              principalId: `user:${viewer.id}`,
              userId: viewer.id,
            },
            content: [{ type: "text", text: `Visible conversation question ${index}` }],
            createdAt: "2026-10-30T12:00:00.000Z",
            id: createId("message"),
            kind: "input",
            runId: null,
            sequence: String(index + 1),
            threadId: page.threadId,
          },
        },
      }));
      return Response.json({
        ok: true,
        data: {
          ...page,
          events,
          readState: { ...page.readState, asOfSequence: "1000" },
          window: {
            byteCount: 4096,
            itemCount: 10,
            hasMore: true,
            nextBefore: "older",
            threadId: page.threadId,
          },
        },
      });
    },
  });
  return { client, requests };
}
