import type { HostClient, HostSnapshot, TranscriptFixtureSnapshot } from "../host/client.js";
import { emptyThreadView, type ThreadViewSource } from "../host/scoped-thread-reader.js";
import { mockInputQueue } from "../mock/mock-scoped-personal.js";

type FixtureCut = HostSnapshot & Partial<TranscriptFixtureSnapshot>;

export function scopedTranscriptFixture(
  read: () => FixtureCut,
  subscribe: ThreadViewSource["subscribe"],
): Pick<HostClient, "getThreadTranscript" | "observeThread" | "getThreadItemText"> {
  const sources = new Map<string, ThreadViewSource>();
  return {
    getThreadTranscript(threadId) {
      const held = sources.get(threadId);
      if (held) return held;
      let previous: FixtureCut | undefined;
      let view = emptyThreadView;
      const source = {
        subscribe,
        getSnapshot() {
          const cut = read();
          if (cut === previous) return view;
          previous = cut;
          const queue = cut.inputQueues?.[threadId];
          view = {
            ...emptyThreadView,
            entries: cut.transcripts?.[threadId] ?? emptyThreadView.entries,
            requests: cut.requests?.[threadId] ?? emptyThreadView.requests,
            runQueue:
              cut.runQueue?.filter((run) => run.threadId === threadId) ?? emptyThreadView.runQueue,
            inputQueue: queue ? mockInputQueue(queue, String(cut.revision), () => false) : null,
            synchronized: cut.connection === "connected",
            hasMore: cut.transcriptWindows?.[threadId]?.hasMore ?? false,
          };
          return view;
        },
      };
      sources.set(threadId, source);
      return source;
    },
    observeThread: () => () => {},
    getThreadItemText: () => undefined,
  };
}
