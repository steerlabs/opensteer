import { agentWho, connectedAgentIdentity, type HostSnapshot } from "@opensteer/client/host";
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import type { Request } from "@opensteer/core";
import { afterEach, describe, expect, it } from "vitest";
import { isAddress } from "../ui/address-words.js";
import {
  needsYouOperation,
  operationRequestsOf,
  placeSessionLine,
  sessionRowOf,
  sessionTaskOf,
  sourceLines,
  whoLines,
} from "./agent-session-model.js";

let host: MockHostClient | undefined;
afterEach(() => host?.dispose());

// The mock's own task ids aren't exported from its index, so the seeded tasks are found by title.
const titles = {
  working: "Find flights to Lisbon",
  waiting: "Buy the phone case",
  stopped: "Renew the parking permit",
  ended: "Compare running shoes",
} as const;
const mockAgentWorkThreads = {} as Record<keyof typeof titles, string>;

function seeded(): HostSnapshot {
  host = new MockHostClient({
    latencyMs: 0,
    connections: mockConnectedAgents("seeded").connections,
  });
  host.mockAgentWork();
  const snapshot = host.getSnapshot();
  for (const [key, title] of Object.entries(titles))
    mockAgentWorkThreads[key as keyof typeof titles] = snapshot.threads.find(
      (thread) => thread.title === title,
    )!.id;
  return snapshot;
}
const named = (label: string) =>
  mockConnectedAgents("seeded").connections.find((connection) => connection.label === label)!;
const requestsOf = (snapshot: HostSnapshot, threadId: string): readonly Request[] =>
  (snapshot as HostSnapshot & { readonly requests?: Record<string, readonly Request[]> })
    .requests?.[threadId] ?? [];

describe("a connected agent's own task on the phone", () => {
  it("is working, waiting, stopped by you, or ended, and only a live one has Stop", () => {
    const snapshot = seeded();
    expect(sessionTaskOf(snapshot, mockAgentWorkThreads.working)).toMatchObject({
      state: "working",
      statusLine: "Claude is working",
      stop: { label: "Stop Claude" },
    });
    expect(sessionTaskOf(snapshot, mockAgentWorkThreads.waiting)).toMatchObject({
      state: "waiting",
      statusLine: "Grok needs you",
    });
    expect(sessionTaskOf(snapshot, mockAgentWorkThreads.stopped)).toMatchObject({
      state: "stopped",
      statusLine: "Stopped by you",
      stop: null,
    });
    expect(sessionTaskOf(snapshot, mockAgentWorkThreads.ended)).toMatchObject({
      state: "ended",
      stop: null,
    });
    const native = snapshot.threads.find(({ agentSessionId }) => !agentSessionId)!;
    expect(sessionTaskOf(snapshot, native.id)).toBeNull();
  });

  it("names the agent and what it uses in Tasks", () => {
    const snapshot = seeded();
    expect(sessionRowOf(snapshot, mockAgentWorkThreads.working)).toMatchObject({
      agent: { name: "Claude", providerId: "anthropic" },
      line: "Claude is working",
      working: true,
    });
    expect(sessionRowOf(snapshot, "thr_00000000-0000-4000-8000-00000000ffff")).toBeNull();
  });

  it("stays the agent's after Stop, with the same session's activity", async () => {
    const snapshot = seeded();
    const view = sessionTaskOf(snapshot, mockAgentWorkThreads.working)!;
    expect(host!.stopAgentSession(mockAgentWorkThreads.working, view.stop!.sessionId)).toBe(true);
    const after = sessionTaskOf(host!.getSnapshot(), mockAgentWorkThreads.working);
    expect(after).toMatchObject({ state: "stopped", stop: null });
    expect(after?.activity).toEqual(view.activity);
  });
});

describe("a direct operation's Request on the phone", () => {
  it("is open first, with the Home's question, the agent's words and the calls apart", () => {
    const snapshot = seeded();
    const [item] = operationRequestsOf(
      snapshot,
      mockAgentWorkThreads.waiting,
      requestsOf(snapshot, mockAgentWorkThreads.waiting),
    );
    expect(item?.view).toMatchObject({
      state: "pending",
      question: "Run a script in Shopping?",
      agentWords: { text: "Buy the $12 phone case you asked for." },
      answers: { allow: { label: "Allow once" }, deny: { label: "Don’t allow" } },
    });
    expect(item?.view.calls?.text).toContain("Place order");
  });

  it("names the agent and the question in Needs you, and nothing for another Request", () => {
    const snapshot = seeded();
    const request = requestsOf(snapshot, mockAgentWorkThreads.waiting)[0]!;
    expect(
      needsYouOperation(snapshot, { request, threadId: mockAgentWorkThreads.waiting }),
    ).toMatchObject({
      listTitle: "Grok: Run a script in Shopping?",
      agent: { name: "Grok" },
    });
    expect(
      needsYouOperation(snapshot, {
        request: { ...request, originatingAgentSessionId: null },
        threadId: mockAgentWorkThreads.waiting,
      }),
    ).toBeNull();
    expect(request.originatingAgentSessionId).toBeTruthy();
  });

  it("says no longer needed once its session was stopped", () => {
    const snapshot = seeded();
    const view = sessionTaskOf(snapshot, mockAgentWorkThreads.waiting)!;
    host!.stopAgentSession(mockAgentWorkThreads.waiting, view.stop!.sessionId);
    const after = host!.getSnapshot();
    const [item] = operationRequestsOf(
      after,
      mockAgentWorkThreads.waiting,
      requestsOf(after, mockAgentWorkThreads.waiting),
    );
    expect(item?.view).toMatchObject({
      state: "withdrawn",
      answers: null,
      settled: "No longer needed: you stopped Grok.",
    });
  });
});

describe("a tab a connected agent uses, on the phone", () => {
  it("says who and for which task, both of you on a shared tab, and stopped after Stop", () => {
    const snapshot = seeded();
    const working = { threadId: mockAgentWorkThreads.working, title: "Find flights to Lisbon" };
    expect(
      placeSessionLine(snapshot, { tabId: "mock-tab-1-0", occupants: [working] }),
    ).toMatchObject({
      line: "Claude is using this page for “Find flights to Lisbon”",
      stop: { sessionId: expect.any(String) },
    });
    const waiting = { threadId: mockAgentWorkThreads.waiting, title: "Buy the phone case" };
    expect(
      placeSessionLine(snapshot, {
        tabId: "mock-tab-0-0",
        sharedFromChrome: true,
        occupants: [waiting],
      })?.line,
    ).toBe("You and Grok are using this page, for “Buy the phone case”");
    const stopped = { threadId: mockAgentWorkThreads.stopped, title: "Renew" };
    expect(placeSessionLine(snapshot, { tabId: "x", occupants: [stopped] })).toMatchObject({
      line: "Stopped by you",
      stop: null,
    });
    expect(placeSessionLine(snapshot, { tabId: null, occupants: [working] })).toBeNull();
    expect(
      placeSessionLine(snapshot, {
        tabId: "x",
        occupants: [{ threadId: "thr_native", title: "t" }],
      }),
    ).toBeNull();
  });
});

describe("who the agent is, on the phone", () => {
  const who = (label: string, redirect?: string, withdrawnAt?: string) =>
    connectedAgentIdentity(named(label), redirect, withdrawnAt ?? null).who;

  it("says a verified pair or platform in the Home's words, and a self-given name as such", () => {
    expect(whoLines(who("Errand"), { consent: true })).toMatchObject({
      heading: "Errand via AgentPay",
      verified: true,
      warning: "Only allow this if you started it yourself.",
    });
    expect(whoLines(who("Claude"), { consent: false })).toMatchObject({
      heading: "Claude",
      detail: "https://claude.ai",
      verified: true,
      warning: null,
    });
    expect(whoLines(who("Grok"), { consent: true })).toMatchObject({
      heading: "Says it is Grok",
      detail: "https://grok.com",
      verified: false,
    });
    expect(whoLines(who("Claude Code"), { consent: true })).toMatchObject({
      heading: "Says it is Claude Code",
      detail: "an app on this computer",
    });
  });

  it("guesses nothing from a domain for an older Home, and says when verification was withdrawn", () => {
    expect(whoLines(who("Shop helper"), { consent: true })).toMatchObject({
      heading: "Says it is Shop helper",
      detail: "https://shophelper.example",
      verified: false,
    });
    const withdrawn = whoLines(who("ChatGPT", undefined, "2026-11-17T09:00:00.000Z"), {
      consent: false,
    });
    expect(withdrawn.verified).toBe(false);
    expect(withdrawn.withdrawn?.line).toMatch(/^No longer verified since /u);
    expect(withdrawn.withdrawn?.detail).toBe("Check its last action or disconnect it.");
  });
});

describe("where a connected agent's task names who works it", () => {
  const who = (label: string, redirect?: string) =>
    connectedAgentIdentity(named(label), redirect, null).who;
  const view = (label: string) => {
    const agent = who(label);
    return {
      agent: { initial: "C", name: label, providerId: null, who: agent },
      header: `Connected agent · ${agent.detail}`,
    };
  };

  it("names the host on the floating title's one line, plain, and the whole origin in the pane", () => {
    const lines = sourceLines(view("Claude"));
    expect(lines).toEqual({
      endsInHost: true,
      short: "Connected agent · claude.ai",
      whole: ["Connected agent · ", { address: "https://claude.ai" }],
    });
  });

  it("keeps a port that is not the default and a scheme that is not https", () => {
    // An agent that only says who it is: the Home knows it by its redirect's origin.
    const agent = agentWho({ clientName: "Dev agent", redirect: "http://192.168.1.20:3000/cb" });
    expect(agent.detail).toBe("http://192.168.1.20:3000");
    const lines = sourceLines({
      agent: { initial: "D", name: "Dev agent", providerId: null, who: agent },
      header: `Connected agent · ${agent.detail}`,
    });
    expect(lines.short).toBe("Connected agent · http://192.168.1.20:3000");
  });

  it("draws a pair's sentence as words, and names the platform on the title", () => {
    const pair = view("Errand");
    expect(isAddress(pair.agent.who.detail), pair.agent.who.detail).toBe(false);
    const lines = sourceLines(pair);
    // Words stay words: never an address part, never a joiner beside a space.
    expect(lines.whole).toEqual([pair.header]);
    expect(lines.short).not.toMatch(/[\u2060\u200B]/u);
    const platform = pair.agent.who.origins.find(({ role }) => role === "platform")?.origin;
    expect(platform).toBeDefined();
    expect(lines.short).toBe(`Connected agent · ${new URL(platform!).host}`);
    expect(lines.endsInHost).toBe(true);
  });

  it("says an app on this computer as it is", () => {
    const local = view("Claude Code");
    expect(sourceLines(local)).toEqual({
      endsInHost: false,
      short: local.header,
      whole: [local.header],
    });
  });
});
