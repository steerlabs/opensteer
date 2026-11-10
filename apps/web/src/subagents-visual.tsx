import { MemoryRouter } from "react-router";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";
import { AgentTranscript } from "./components/agent-activity.js";
import type { HostSnapshot, NodeEntry, TranscriptEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";

/**
 * The mock conversation's helpers as a task's trace draws them, without a Host.
 * Scenarios, by `?scenario=`:
 *   live    — the turn at work: groups, a workflow and a background task in place
 *   folded  — the turn ended while one helper still runs: the fold line names
 *             the helpers and the running one stands outside the fold
 *   thirty  — thirty helpers in one group, one needing the reader
 *   narrow  — `live` in a 360px column
 *   offline — `live` while the Host is out of reach
 */
const scenario = new URLSearchParams(location.search).get("scenario") ?? "live";
const client = new MockHostClient({ latencyMs: 0, places: "absent" });
const snapshot = client.getSnapshot();
const thread = snapshot.threads.find((candidate) => candidate.title === "Subagents everywhere")!;
const seeded = snapshot.transcripts[thread.id]!;

function entriesFor(): TranscriptEntry[] {
  if (scenario === "folded")
    return seeded.map((entry) =>
      entry.kind === "run" && entry.status === "running"
        ? { ...entry, status: "completed", endedAt: "2026-11-10T14:45:00.000Z" }
        : entry.kind === "node" && entry.status === "running" && entry.title !== "Trace the client"
          ? { ...entry, status: "completed", completedAt: "2026-11-10T14:40:00.000Z" }
          : entry,
    );
  if (scenario === "thirty") {
    const template = seeded.find(
      (entry): entry is NodeEntry => entry.kind === "node" && entry.title === "Trace the client",
    )!;
    const asking = seeded.find(
      (entry): entry is NodeEntry =>
        entry.kind === "node" && entry.title === "Review the experience",
    )!;
    const helpers = Array.from({ length: 30 }, (_, index): NodeEntry =>
      index === 10
        ? asking
        : {
            ...template,
            id: `node:visual-${index}`,
            nodeId: `nod_visual-${index}`,
            title: `Read file ${index + 1} of the event store`,
            ...(index % 3 === 2
              ? {
                  status: "completed" as const,
                  completedAt: "2026-11-10T14:30:00.000Z",
                  result: "Nothing in this file filters detail events.",
                }
              : index === 25
                ? { status: "failed" as const, completedAt: "2026-11-10T14:31:00.000Z" }
                : {}),
          },
    );
    return [...seeded.filter((entry) => entry.kind === "run"), ...helpers];
  }
  return seeded;
}

const entries = entriesFor();
const reader: HostSnapshot =
  scenario === "offline" ? { ...snapshot, connection: "offline" } : snapshot;

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <main className="page">
      <div
        className="transcript"
        style={{ maxWidth: scenario === "narrow" ? 360 : undefined, margin: "0 auto" }}
      >
        <AgentTranscript
          activity={scenario === "folded" ? "idle" : "working"}
          entries={entries}
          live={scenario !== "offline"}
          subagentReader={reader}
          threadId={thread.id}
          waitingRequests={snapshot.waitingRequests}
        />
      </div>
    </main>
  </MemoryRouter>,
);
