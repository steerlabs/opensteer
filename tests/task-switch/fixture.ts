import { createId, type ThreadId } from "../../packages/core/src/index.js";
import type { PendingAgentEvent } from "../../packages/protocol/src/index.js";
import { createPersonalRunFixturePort } from "../../packages/database/src/personal-run-fixture.test-support.js";
import { pendingEvent } from "../../packages/database/src/store.integration.test-support.js";
import type { PrivateMachineHost } from "../../apps/host/src/runtime/private-machine-host.test-support.js";
import { sql } from "kysely";

const reportSection = [
  "### Source SOURCE under review",
  "",
  "The **browser research** cross-checked SOURCE against the *source notes*.",
  "",
  "- A second visit confirmed the label for SOURCE.",
  "- The recorded path was consistent with the listed constraints.",
  "",
  "| Finding | State |",
  "| --- | --- |",
  "| Page content for SOURCE | Confirmed |",
  "",
  "```json",
  '{"source":"SOURCE","status":"checked"}',
  "```",
  "",
].join("\n");
export function researchReports(batch: string) {
  return [24, 64, 112].map((kiB) => {
    const heading = `## Research report (${kiB} KiB)\n\n`;
    const sections = [heading];
    let bytes = heading.length;
    while (bytes < kiB * 1024) {
      const index = String(sections.length).padStart(3, "0");
      const section = reportSection.replaceAll("SOURCE", `${batch}-${kiB}-${index}`);
      sections.push(section);
      bytes += section.length; // The fixture uses ASCII.
    }
    return sections.join("");
  });
}

export async function createSwitchFixture(host: PrivateMachineHost) {
  const tasks = createPersonalRunFixturePort(host.store);
  const a = await tasks.createTask({ ownerId: host.ownerId, suffix: "switch A" });
  const b = await tasks.createTask({ ownerId: host.ownerId, suffix: "switch B" });
  const activeA = await tasks.startTask(a.threadId, "Task A fixture prompt");
  const activeB = await tasks.startTask(b.threadId, "Task B fixture prompt");
  // The fixture seed may run longer than the synthetic Runner's one-minute lease.
  await sql`update provider_sessions set lease_expires_at = now() + interval '15 minutes' where active`.execute(
    host.store.database,
  );
  function writer(threadId: ThreadId, run: typeof activeB) {
    const environmentId = run.turn.command.environmentId;
    if (!environmentId) throw new Error("The fixture run has no environment.");
    let ordinal = 1;
    let calls = 0;
    const commit = async <Type extends "assistant.message" | "tool.started" | "tool.completed">(
      type: Type,
      data: Extract<PendingAgentEvent, { type: Type }>["data"],
    ) => {
      const result = await host.store.commitRunnerEvent({
        environmentId,
        runnerBootId: run.runnerBootId,
        runnerId: host.hostingComputerId,
        event: pendingEvent({
          threadId,
          runId: run.runId,
          type,
          data,
          environmentId,
          bindingGeneration: run.bindingGeneration,
          ordinal: ordinal++,
        } as Omit<PendingAgentEvent, "emittedAt">),
      });
      if (result.replayed) throw new Error(`Duplicate fixture event ${type} ${ordinal - 1}`);
    };
    return {
      async message(text: string) {
        const messageId = createId("message");
        await commit("assistant.message", { messageId, content: [{ type: "text", text }] });
        return messageId;
      },
      async tool() {
        const callId = `browser-call-${++calls}`;
        await commit("tool.started", {
          callId,
          tool: { namespace: "browser", name: "snapshot" },
          arguments: { url: `https://example.invalid/research/${calls}` },
        });
        await commit("tool.completed", {
          callId,
          isError: false,
          output: { text: `Synthetic page ${calls}: headings, links and source observations.` },
        });
      },
    };
  }
  const writeA = writer(a.threadId, activeA);
  const writeB = writer(b.threadId, activeB);
  return {
    a: {
      threadId: a.threadId,
      title: a.thread.title,
      messageId: await writeA.message("Task A transcript ready"),
    },
    b: {
      threadId: b.threadId,
      title: b.thread.title,
      messageId: await writeB.message("Task B transcript ready"),
    },
    async accrue(commits: number, reportBodies: readonly string[], label: string) {
      // Each call is two durable Runner events. End the research batch with its longest
      // report so the normal newest-reply renderer opens actual Markdown.
      const messages = reportBodies.length || 1;
      const toolCalls = Math.floor((commits - messages) / 2);
      for (let index = 0; index < toolCalls; index++) await writeB.tool();
      if ((commits - messages) % 2) await writeB.message("Research batch reviewed");
      const reportIds = [];
      for (const body of reportBodies) reportIds.push(await writeB.message(body));
      const messageId =
        reportIds.at(-1) ?? (await writeB.message(`Task B latest reply for ${label}`));
      return { toolCalls, messageId, reportIds };
    },
  };
}
