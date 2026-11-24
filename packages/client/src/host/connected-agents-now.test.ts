import { describe, expect, it } from "vitest";
import { mockAgentWork, mockAgentWorkThreads } from "../mock/mock-agent-work.js";
import { mockConnectedAgents } from "../mock/mock-connected-agents.js";
import type { ThreadSummary, WaitingRequestView } from "./client.js";
import { connectedAgentsNow } from "./connected-agents-now.js";

const now = new Date("2026-11-20T12:00:00.000Z");
const { connections } = mockConnectedAgents("seeded", now);
const seed = mockAgentWork({
  now,
  userId: "usr_0192f4a1-0000-4000-8000-000000000001",
  template: {
    id: "thr_00000000-0000-4000-8000-000000000001",
    title: "Task",
    status: "idle",
  } as ThreadSummary,
  connections,
  livePanel: "needs-you",
});
const task = (key: keyof typeof mockAgentWorkThreads) =>
  seed.threads.find(({ id }) => id === mockAgentWorkThreads[key])!;
const chatgpt = task("shopping");
const claude = task("waiting");
const grok = task("working");
const secondWaiting = { ...grok, status: "waiting" as const };
const claudeWorking = { ...claude, status: "running" as const };
const waiting = seed.requests[claude.id]![0]!;
if (waiting.status !== "pending") throw new Error("The fixture must be waiting.");
const request: WaitingRequestView = { request: waiting, assignments: [], subagent: null };
const operations = seed.operations.map(({ operation }) => operation);
const view = (
  tasks: readonly ThreadSummary[],
  waitingRequests: readonly WaitingRequestView[] = [],
) => connectedAgentsNow({ tasks, waitingRequests, operations });

describe("connected agents working now", () => {
  it.each([
    [[chatgpt], "ChatGPT is working in Shopping"],
    [[chatgpt, claudeWorking, grok], "3 agents working"],
    [[chatgpt, grok, claude], "Claude needs you · 2 working"],
    [[claude, secondWaiting, chatgpt], "2 agents need you · 1 working"],
    [[claude], "Claude needs you"],
    [[claude, secondWaiting], "2 agents need you"],
    [[], null],
  ] as const)("presents the headline for %#", (tasks, headline) => {
    expect(view(tasks).headline).toBe(headline);
  });

  it("counts one session once across distinct active places and repeats of the same place", () => {
    const latest = operations.find(({ taskId }) => taskId === chatgpt.id)!;
    const otherPlace = {
      ...latest,
      target: {
        ...latest.target,
        grant: { kind: "browser-profile" as const, profileId: "travel" },
        name: "Travel",
      },
    };
    const result = connectedAgentsNow({
      tasks: [chatgpt, chatgpt],
      waitingRequests: [],
      operations: [latest, latest, otherPlace],
    });
    expect(result.headline).toBe("ChatGPT is working in 2 places");
    expect(result.agents).toMatchObject([
      {
        sessionId: chatgpt.externalWork!.sessionId,
        threadId: chatgpt.id,
        state: "working",
        places: [{ name: "Shopping", device: { name: "Studio Mac" } }, { name: "Travel" }],
        action: "Run a script on Shopping",
      },
    ]);
  });

  it("leads with the waiting Request, even if the task still says running", () => {
    const result = view([chatgpt, claudeWorking], [request]);
    expect(result.headline).toBe("Claude needs you · 1 working");
    expect(result.agents[0]).toMatchObject({
      state: "needs-you",
      places: [{ name: "Travel", device: { name: "Studio Mac" } }],
      action: "Run a script in Travel?",
      waiting: request,
    });
  });

  it("ignores idle, ended, stopped and disconnected sessions", () => {
    const busy = { status: "running" as const };
    const ended = {
      ...chatgpt,
      externalWork: {
        ...chatgpt.externalWork!,
        status: "ended" as const,
        endReason: "idle" as const,
      },
    };
    expect(
      view([
        { ...chatgpt, status: "idle" },
        ended,
        { ...task("stopped"), ...busy },
        { ...task("ended"), ...busy },
      ]),
    ).toEqual({ headline: null, headlineParts: [], agents: [] });
  });

  it("keeps self-declared names distinct and needs no place to show the line", () => {
    expect(connectedAgentsNow({ tasks: [grok], waitingRequests: [] }).headline).toBe(
      "“Grok” is working",
    );
  });
});

describe("headline counts distinct connections", () => {
  const anotherSession = {
    ...grok,
    externalWork: { ...grok.externalWork!, connection: chatgpt.externalWork!.connection },
  };
  const otherPlace = operations.find(({ taskId }) => taskId === anotherSession.id)!;
  const activity = [
    ...operations.filter((operation) => operation !== otherPlace),
    {
      ...otherPlace,
      target: {
        ...otherPlace.target,
        grant: { kind: "browser-profile" as const, profileId: "work" },
      },
    },
  ];

  it("names both places across one agent's two working sessions", () => {
    const result = connectedAgentsNow({
      tasks: [chatgpt, anotherSession],
      waitingRequests: [],
      operations: activity,
    });
    expect(result.headline).toBe("ChatGPT is working in 2 places");
    expect(result.agents).toHaveLength(2);
  });

  it("counts an agent with a waiting session only in needs you", () => {
    const result = view([chatgpt, { ...anotherSession, status: "waiting" }]);
    expect(result.headline).toBe("ChatGPT needs you");
    expect(result.agents).toHaveLength(2);
  });

  it("counts two agents across three working sessions", () => {
    expect(view([chatgpt, anotherSession, claudeWorking]).headline).toBe("2 agents working");
  });
});
