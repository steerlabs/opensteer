import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import type { MessageEntry, RunEntry, ToolEntry } from "@opensteer/client/host";
import { AgentTranscript } from "./agent-activity.js";

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    arguments: { command: "pnpm test" },
    callId: "call-1",
    completedAt: "2026-08-16T10:00:04.000Z",
    createdAt: "2026-08-16T10:00:01.000Z",
    id: "tool:run-a:call-1",
    integration: null,
    isError: false,
    kind: "tool",
    output: { text: "12 tests passed" },
    runId: "run-a",
    state: "done",
    streamText: "",
    tool: { name: "shell", namespace: "codex" },
    ...overrides,
  };
}

describe("AgentTranscript", () => {
  it("keeps the last activity but removes live clocks, shimmer and typing when disconnected", () => {
    const entries = [tool({ state: "running", completedAt: null })];
    const live = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript entries={entries} />
      </MemoryRouter>,
    );
    expect(live).toContain("work--live");
    expect(live).toContain("work__clock");
    const stale = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript activity="working" entries={entries} live={false} />
      </MemoryRouter>,
    );
    expect(stale).toContain("work__label");
    expect(stale).not.toContain("work--live");
    expect(stale).not.toContain("work__clock");
    expect(stale).not.toContain("stream-caret");
    expect(
      renderToStaticMarkup(<AgentTranscript activity="working" entries={[]} live={false} />),
    ).not.toContain("working__orb");
  });

  it("positions only the viewing human as the user and labels every other author", () => {
    const viewerUserId = createId("user");
    const otherUserId = createId("user");
    const threadId = createId("thread");
    const runId = createId("run");
    const workspaceId = createId("workspace");
    const entries: MessageEntry[] = [
      {
        author: {
          displayName: "Alex",
          kind: "human",
          principalId: `user:${viewerUserId}`,
          userId: viewerUserId,
        },
        body: "My request",
        createdAt: "2026-08-16T10:00:00.000Z",
        id: "message-human-self",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        author: {
          displayName: "Alex",
          kind: "human",
          principalId: `user:${otherUserId}`,
          userId: otherUserId,
        },
        body: "A collaborator update",
        createdAt: "2026-08-16T10:00:01.000Z",
        id: "message-human-other",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
      {
        author: {
          displayName: "Flight research",
          kind: "agent",
          runId,
          threadId,
          workspaceId,
          workspaceName: "Travel",
        },
        body: "I found three options",
        createdAt: "2026-08-16T10:00:02.000Z",
        id: "message-agent",
        kind: "message",
        messageKind: "assistant",
        runId,
      },
    ];

    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript entries={entries} viewerUserId={viewerUserId} />
      </MemoryRouter>,
    );

    expect(markup.match(/class="msg--user"/g)).toHaveLength(1);
    expect(markup).toContain("msg--assistant");
    expect(markup).toContain("Alex");
    expect(markup).toContain("Flight research");
  });

  it("renders a collaborator's message as plain labeled input, not agent output", () => {
    const viewerUserId = createId("user");
    const entries: MessageEntry[] = [
      {
        author: {
          displayName: "Alex",
          kind: "human",
          principalId: `user:${createId("user")}`,
          userId: createId("user"),
        },
        body: "A collaborator update",
        createdAt: "2026-08-16T10:00:01.000Z",
        id: "message-human-other",
        kind: "message",
        messageKind: "input",
        runId: null,
      },
    ];

    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript entries={entries} viewerUserId={viewerUserId} />
      </MemoryRouter>,
    );

    expect(markup).toContain("msg--input");
    expect(markup).toContain("input-card__plain");
    expect(markup).toContain("Alex");
    expect(markup).toContain('dateTime="2026-08-16T10:00:01.000Z"');
    expect(markup).not.toContain("md-prose");
    expect(markup).not.toContain("msg--assistant");
    expect(markup).not.toContain("input-card__open");
  });

  it("counts steps that returned an error without calling the turn a failure", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscript
        entries={[
          run(),
          tool({ isError: true, output: { text: "exit 1" }, state: "failed" }),
          reply(),
        ]}
      />,
    );
    expect(markup).toContain("1 error");
    expect(markup).not.toContain("run-failure");
  });

  it("never puts what a Run consumed under its turn, whatever the engine stated", () => {
    const usage = {
      cachedInputTokens: 12_760,
      costUsd: 0.0873,
      inputTokens: 18_430,
      outputTokens: 1_265,
    };
    for (const status of ["running", "completed", "failed", "interrupted"] as const) {
      const markup = renderToStaticMarkup(
        <AgentTranscript entries={[run({ status, usage }), tool(), reply()]} />,
      );
      expect(markup).not.toMatch(/\d+(\.\d+)?k (in|out)|cached|\$0\.09|Execution details/);
    }
  });

  it("puts a failed Run's outcome after its reply", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscript
        entries={[
          run({
            error: { code: "runner_lost", message: "The Runner disconnected.", retryable: true },
            status: "failed",
          }),
          tool({ completedAt: "2026-08-16T10:00:04.000Z", state: "stopped" }),
          reply(),
        ]}
      />,
    );
    expect(markup.indexOf("All tests pass.")).toBeLessThan(markup.indexOf("run-failure"));
    expect(markup).toContain("The Runner disconnected.");
  });
});

function run(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    createdAt: "2026-08-16T10:00:00.000Z",
    error: null,
    id: "run:run-a",
    kind: "run",
    replyMessageId: null,
    runId: "run-a",
    status: "completed",
    ...overrides,
  };
}

function reply(overrides: Partial<MessageEntry> = {}): MessageEntry {
  return {
    author: { cause: "test", kind: "platform" },
    body: "All tests pass.",
    createdAt: "2026-08-16T10:00:05.000Z",
    id: "message-reply",
    kind: "message",
    messageKind: "assistant",
    runId: "run-a",
    ...overrides,
  };
}
