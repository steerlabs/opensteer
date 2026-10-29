import { AgentEventSchema, type AgentEvent } from "@opensteer/core";
import { foldTranscriptEvent, type TranscriptEntry } from "@opensteer/client/host";

/** Synthetic shape of the overnight incident; no user's text or identifiers. */
export function largeTranscriptFixture() {
  const events: AgentEvent[] = [];
  const id = (prefix: string, number: number) =>
    `${prefix}_00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
  const add = (type: AgentEvent["type"], data: unknown, run: number) => {
    const sequence = events.length + 1;
    events.push(
      AgentEventSchema.parse({
        createdAt: new Date(Date.UTC(2026, 9, 25) + sequence * 5_000).toISOString(),
        data,
        environmentId: id("env", 1),
        eventId: id("evt", sequence),
        runId: id("run", run),
        sequence: String(sequence),
        threadId: id("thr", 2),
        type,
        workspaceId: id("wsp", 1),
      }),
    );
  };
  let messages = 0;
  let tools = 0;
  for (let run = 1; run <= 188; run++) {
    add("run.started", { status: "running" }, run);
    const messageCount = 5 + Number(run <= 144);
    const toolCount = 5 + Number(run <= 138);
    for (let step = 0; step < 18 + Number(run <= 4); step++) {
      add(
        "reasoning.completed",
        {
          blockId: `reasoning-${run}-${step}`,
          text: `Inspecting synthetic step ${step} of run ${run}.\n`.repeat(8),
        },
        run,
      );
      if (step < toolCount) {
        const callId = `call-${++tools}`;
        add(
          "tool.started",
          {
            callId,
            tool: { namespace: "functions", name: "exec_command" },
            arguments: { cmd: "read synthetic output" },
          },
          run,
        );
        add(
          "tool.completed",
          {
            callId,
            isError: false,
            output: {
              text: `Synthetic output for tool ${tools}: a repeatable line of diagnostic text.\n`.repeat(
                40,
              ),
            },
          },
          run,
        );
      }
      if (step < messageCount) {
        const messageId = id("msg", ++messages);
        const text =
          messages === 1084
            ? "Overnight transcript complete. This is the newest reply."
            : `## Run ${run}, update ${step + 1}\n\n` +
              "This synthetic update records the work completed so far. The next step checks the same task without relying on private data.\n\n".repeat(
                8,
              );
        if (messages !== 1084)
          add("assistant.message", { messageId, content: [{ type: "text", text }] }, run);
      }
    }
    // The final answer follows the work that produced it, including on a short phone screen.
    if (run === 188)
      add(
        "assistant.message",
        {
          messageId: id("msg", messages),
          content: [
            { type: "text", text: "Overnight transcript complete. This is the newest reply." },
          ],
        },
        run,
      );
    add("run.completed", { status: "completed", replyMessageId: id("msg", messages) }, run);
  }
  const entries = events.reduce<TranscriptEntry[]>(foldTranscriptEvent, []);
  return {
    entries,
    events,
    newestMessageId: id("msg", messages),
    counts: {
      runs: 188,
      events: events.length,
      messages,
      tools,
      bytes: Buffer.byteLength(JSON.stringify(events)),
      entries: entries.length,
    },
  };
}
