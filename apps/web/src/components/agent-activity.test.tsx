import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createId, runTerminationUnprovenCode } from "@opensteer/core";
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
  it("keeps the last activity but removes shimmer and typing when disconnected", () => {
    const entries = [tool({ state: "running", completedAt: null })];
    const live = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript entries={entries} />
      </MemoryRouter>,
    );
    expect(live).toContain("work--live");
    const stale = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript activity="working" entries={entries} live={false} />
      </MemoryRouter>,
    );
    expect(stale).toContain("work__label");
    expect(stale).not.toContain("work--live");
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
        },
        body: "I found three options",
        createdAt: "2026-08-16T10:00:02.000Z",
        id: "message-agent",
        kind: "message",
        messageKind: "assistant",
        runId,
      },
      {
        author: {
          kind: "connection",
          connectionId: "mcn_external",
          displayName: "Connected research agent",
        },
        body: "External agent input",
        createdAt: "2026-08-16T10:00:03.000Z",
        id: "message-connection",
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

    expect(markup.match(/class="msg--user"/g)).toHaveLength(1);
    expect(markup).toContain("msg--assistant");
    expect(markup).toContain("Alex");
    expect(markup).toContain("Flight research");
    expect(markup).toContain("Connected research agent");
  });

  it("gives connection-authored input no row in a conversation, like other agent input", () => {
    const entry: MessageEntry = {
      author: { kind: "connection", connectionId: "mcn_external", displayName: "Research agent" },
      body: "External agent input",
      createdAt: "2026-11-03T10:00:00.000Z",
      id: "message-connection",
      kind: "message",
      messageKind: "input",
      runId: null,
    };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript conversation entries={[entry]} viewerUserId="owner" />
      </MemoryRouter>,
    );
    // A conversation draws what its agent says and what needs the reader; an
    // external agent's input is for that agent, and is never drawn as the person.
    expect(markup).not.toContain("External agent input");
    expect(markup).not.toContain('class="msg--user"');
  });

  it("renders a collaborator's message as their own labeled words, not agent output", () => {
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
    // A person's words read with the person profile, never as an agent's Markdown.
    expect(markup).toContain("md-prose--person");
    expect(markup).toContain('<span class="input-card__name">Alex</span>');
    // Another person is not a place to go: their name is not a link.
    expect(markup).not.toContain('<a class="input-card__sender"');
    expect(markup).not.toContain("msg--assistant");
  });

  // Failure mode: a step the agent read and carried on from reads as the
  // turn failing, or as an alarm on a turn that answered.
  it("keeps a step that returned an error behind the status line, without calling the turn a failure", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscript
        entries={[
          run(),
          tool({ isError: true, output: { text: "exit 1" }, state: "failed" }),
          reply(),
        ]}
      />,
    );
    expect(markup).toContain("Worked for");
    expect(markup).not.toContain("error");
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

  it("says stopping could not be confirmed instead of Run failed when termination is unproven", () => {
    const unproven = run({
      error: {
        code: runTerminationUnprovenCode,
        message: "The Runner could not verify that all Run processes stopped.",
        retryable: false,
      },
      status: "failed",
    });
    for (const conversation of [false, true]) {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <AgentTranscript conversation={conversation} entries={[unproven]} />
        </MemoryRouter>,
      );
      expect(markup).not.toContain("Run failed");
      expect(markup).not.toContain("Opensteer couldn’t finish");
      expect(markup).toContain("Couldn’t confirm this stopped");
      expect(markup).toContain("may still be running on that device");
      expect(markup).not.toContain("Force unlock");
      expect(markup).not.toContain("Ignore");
    }
    const confirmed = run({
      status: "interrupted",
      stopConfirmedAt: "2026-08-16T10:05:00.000Z",
    });
    const confirmedMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript entries={[confirmed]} />
      </MemoryRouter>,
    );
    expect(confirmedMarkup).toContain("Run stopped.");
    expect(confirmedMarkup).toContain("Confirmed stopped at");
  });

  it("explains in plain words when a shared engine retired under another task's stop", () => {
    const retired = run({
      interruptedCause: "engine-retired",
      status: "interrupted",
    });
    for (const conversation of [false, true]) {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <AgentTranscript conversation={conversation} entries={[retired]} />
        </MemoryRouter>,
      );
      expect(markup).not.toContain("Run stopped.");
      expect(markup).toContain("Run cut short");
      expect(markup).toContain("restart its engine to make sure another task had stopped");
      expect(markup).toContain("send a message to continue");
    }
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

it("renders an addressed message with the normal assistant renderer", () => {
  const addressed: MessageEntry = {
    id: "notice",
    kind: "message",
    messageKind: "assistant",
    runId: "run-a",
    createdAt: "2026-08-16T10:00:00.000Z",
    author: { kind: "platform", cause: "test" },
    body: "Milestone passed.",
    addressedToUserId: "person",
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AgentTranscript entries={[addressed]} />
    </MemoryRouter>,
  );
  expect(html).toContain("Milestone passed.");
  expect(html).toContain('data-message-id="notice"');
});

it("renders a live provider retry notice in both conversation and activity views", () => {
  const retryingRun = run({
    status: "running",
    retry: {
      status: "retrying",
      attempt: 2,
      maxAttempts: 5,
      retryDelayMs: 308_000,
      message: "Selected model is at capacity.",
    },
  });
  for (const conversation of [true, false]) {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentTranscript conversation={conversation} entries={[retryingRun]} />
      </MemoryRouter>,
    );
    expect(html).toContain("Retrying (2/5)");
    expect(html).toContain("Selected model is at capacity.");
    expect(html).toContain("5m 8s retry delay");
  }
  const clearedHtml = renderToStaticMarkup(
    <MemoryRouter>
      <AgentTranscript conversation entries={[run({ status: "running" })]} />
    </MemoryRouter>,
  );
  expect(clearedHtml).not.toContain("Retrying");
});
