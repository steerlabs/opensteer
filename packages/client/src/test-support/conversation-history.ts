import { createId } from "@opensteer/core";
import { HttpHostClient } from "../host/host-session-client.js";
import { MockPersonalSocket } from "../mock/mock-personal-host.js";
import type { MockHostClient } from "../mock/mock-host-client.js";
import { ScopedClientMessageSchema } from "@opensteer/protocol/personal-sync";
import type { TranscriptItem } from "@opensteer/protocol/transcript";

export function conversationHistoryHost(source: MockHostClient) {
  const reads: string[] = [];
  const detailRequests: string[] = [];
  const throughSequence = "1000";
  let socket: MockPersonalSocket;
  const connect = () =>
    (socket = new MockPersonalSocket((data) => {
      const message = ScopedClientMessageSchema.parse(JSON.parse(data));
      const sendDetail = (
        subscription:
          | Extract<typeof message, { type: "client.subscribe" }>
          | NonNullable<Extract<typeof message, { type: "client.attach" }>["selected"]>,
      ) => {
        const { scope, subscriptionId, generation } = subscription;
        if (scope.kind !== "thread" || subscriptionId === "shell") return;
        const snapshot = source.scopedDetail(scope.threadId, undefined, undefined, throughSequence);
        if (!snapshot) return;
        detailRequests.push(scope.threadId);
        const items = Array.from({ length: 10 }, (_, index): TranscriptItem => {
          const id = createId("message");
          return {
            id,
            kind: "message",
            messageId: id,
            messageKind: "input",
            position: String(index + 1),
            revision: throughSequence,
            runId: null,
            attemptId: null,
            nodeId: null,
            isTurnStart: true,
            author: { kind: "human", displayName: "Owner", principalId: "user:fixture" },
            createdAt: "2026-10-30T12:00:00.000Z",
            view: { preview: `Visible conversation question ${index}`, published: true },
          };
        });
        const address = { scope, subscriptionId, generation, throughSequence };
        socket.deliver({
          ...address,
          type: "host.snapshot",
          snapshot: { ...snapshot, items, nextBefore: null },
        });
        socket.deliver({ ...address, type: "host.synchronized" });
      };
      // A server reply crosses the socket boundary after the client's send.
      queueMicrotask(() => {
        if (message.type === "client.subscribe") sendDetail(message);
        if (message.type !== "client.attach") return;
        const address = {
          scope: { kind: "shell" } as const,
          subscriptionId: "shell" as const,
          generation: message.generation,
          throughSequence,
        };
        socket.deliver({
          ...address,
          type: "host.snapshot",
          snapshot: source.scopedShell(message.selected?.scope.threadId, throughSequence),
        });
        socket.deliver({ ...address, type: "host.synchronized" });
        if (message.selected) sendDetail(message.selected);
      });
    }));
  const client = new HttpHostClient({
    baseUrl: "http://mock-host",
    capabilities: [],
    webSocketFactory: connect,
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      reads.push(url.pathname);
      return Response.json({
        ok: false,
        error: { code: "not_found", message: "Unavailable", retryable: false },
      });
    },
  });
  return { client, reads, detailRequests };
}
