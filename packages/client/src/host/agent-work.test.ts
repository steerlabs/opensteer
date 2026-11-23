import type { AgentOperationView } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { mockConnectedAgents } from "../mock/mock-connected-agents.js";
import { mockAgentWork, mockAgentWorkThreads } from "../mock/mock-agent-work.js";
import { agentWho, agentWithdrawnLine } from "./agent-identity.js";
import {
  operationDecisionField,
  sessionQuestions,
  sessionSlotFromHome,
  operationRequestView,
  operationRow,
  sessionTaskRow,
  sessionTaskView,
  tabAgentLine,
} from "./agent-work.js";
import type { ThreadSummary } from "./client.js";
import { connectedAgentIdentity } from "./connected-agent-view.js";

const now = new Date("2026-11-20T12:00:00.000Z");
const { connections } = mockConnectedAgents("seeded", now);
const named = (label: string) => connections.find((connection) => connection.label === label)!;
const seed = mockAgentWork({
  now,
  userId: "usr_0192f4a1-0000-4000-8000-000000000001",
  template: {
    id: "thr_00000000-0000-4000-8000-000000000001",
    title: "t",
    status: "idle",
  } as ThreadSummary,
  connections,
});
const slot = (thread: keyof typeof mockAgentWorkThreads) => {
  const id = mockAgentWorkThreads[thread];
  return sessionSlotFromHome(
    seed.threads.find((thread) => thread.id === id)!.externalWork,
    seed.operations
      .filter(({ operation }) => operation.taskId === id)
      .map(({ operation }) => operation)
      .reverse(),
  )!;
};

describe("who a connected agent is", () => {
  it("names a verified agent in the Home's words, with a logo only for a known one", () => {
    const errand = agentWho({
      ...named("Errand"),
      redirect: "https://agentpay.example/cb",
    });
    expect(errand).toMatchObject({
      heading: "AgentPay",
      verified: true,
      selfAsserted: false,
      providerId: null,
    });
    const claude = agentWho({
      ...named("Claude"),
      redirect: "https://claude.ai/cb",
    });
    expect(claude).toMatchObject({
      heading: "Claude",
      detail: "https://claude.ai",
      verified: true,
      providerId: "anthropic",
    });
    expect(claude.warning).toBe("Only allow this if you started it yourself.");
  });

  it("marks a self-given name as self-given, with its origin or an app on this computer", () => {
    expect(agentWho({ ...named("Grok"), redirect: "https://grok.com/cb" })).toMatchObject({
      heading: "Grok",
      detail: "https://grok.com",
      verified: false,
      selfAsserted: true,
      providerId: null,
    });
    expect(
      agentWho({ ...named("Claude Code"), redirect: "http://127.0.0.1:53682/cb" }),
    ).toMatchObject({
      detail: "an app on this computer",
      local: true,
      selfAsserted: true,
    });
  });

  it("guesses no provider from a domain when the Home reports nothing", () => {
    for (const redirect of [
      "https://chatgpt.com/cb",
      "https://evil.chatgpt.com/cb",
      "https://claude.ai.evil.example/cb",
    ]) {
      const who = agentWho({ clientName: "ChatGPT", redirect });
      expect(who).toMatchObject({
        heading: "ChatGPT",
        verified: false,
        selfAsserted: true,
        providerId: null,
      });
      expect(who.detail).toBe(new URL(redirect).origin);
    }
    expect(agentWho({ clientName: "CLI", redirect: "http://localhost:4000/cb" }).detail).toBe(
      "an app on this computer",
    );
    expect(
      connectedAgentIdentity({ label: "x", clientName: "ChatGPT" }, "https://chatgpt.com/cb")
        .providerId,
    ).toBeNull();
  });

  it("stops vouching once the Home withdrew verification, and says since when", () => {
    const withdrawn = agentWho({
      ...named("ChatGPT"),
      redirect: null,
      withdrawnAt: "2026-11-17T09:00:00.000Z",
    });
    expect(withdrawn).toMatchObject({
      verified: false,
      providerId: null,
      withdrawnSince: "2026-11-17T09:00:00.000Z",
    });
    expect(agentWithdrawnLine(withdrawn, "en-US")).toBe("No longer verified since Nov 17, 2026.");
    expect(
      agentWithdrawnLine(
        agentWho({
          ...named("Grok"),
          redirect: null,
          withdrawnAt: "2026-11-17T09:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });
});

describe("a task a connected agent works itself", () => {
  const view = (thread: keyof typeof mockAgentWorkThreads, status: ThreadSummary["status"]) =>
    sessionTaskView({
      thread: { status, agentSessionId: slot(thread).sessionId },
      slot: slot(thread),
    });

  it("works, waits, is stopped or ends, and offers Stop only while its session is live", () => {
    expect(view("working", "running")).toMatchObject({
      state: "working",
      statusLine: "Claude is working",
      stop: { label: "Stop Claude" },
    });
    expect(view("waiting", "waiting")).toMatchObject({
      state: "waiting",
      statusLine: "Grok needs you",
    });
    expect(view("stopped", "idle")).toMatchObject({
      state: "stopped",
      statusLine: "Stopped by you",
      stop: null,
    });
    expect(view("ended", "idle")).toMatchObject({
      state: "ended",
      statusLine: "Ended: Shop helper was disconnected",
      stop: null,
    });
    expect(view("working", "running")?.noComposer).toBe(
      "Claude works this task itself. You can’t write to it here.",
    );
    expect(view("working", "running")?.header).toBe("Connected agent · https://claude.ai");
  });

  it("is idle when its session is live but quiet, and is any other task's business otherwise", () => {
    expect(
      sessionTaskView({ thread: { status: "idle", agentSessionId: "ags_x" }, slot: null }),
    ).toMatchObject({
      state: "idle",
      statusLine: "A connected agent is idle",
      activity: { kind: "unavailable" },
    });
    expect(sessionTaskView({ thread: { status: "running" }, slot: null })).toBeNull();
  });

  it("names the agent and what it is using in Tasks", () => {
    expect(sessionTaskRow({ thread: { status: "running" }, slot: slot("working") })).toMatchObject({
      agent: { name: "Claude", providerId: "anthropic" },
      line: "Claude · Travel",
      working: true,
    });
  });
});

describe("one operation in a task's activity", () => {
  const rows = slot("working").operations!.map(operationRow);

  it("says what it did in plain words and who allowed it", () => {
    expect(rows[0]).toMatchObject({
      glyph: "globe",
      action: "Listed tabs in Travel on Studio Mac",
      allowedBy: "Reading only",
    });
    expect(rows[1]).toMatchObject({
      action: "Opened a tab in Travel on Studio Mac",
      allowedBy: "Full access",
    });
    expect(rows[2]).toMatchObject({
      action: "Ran a script on Travel on Studio Mac",
      allowedBy: "Allowed by Auto",
      outcome: { label: "Failed", tone: "bad" },
    });
  });

  it("never says it ran what may not have: waiting, running, uncertain or not allowed", () => {
    expect(rows[3]?.action).toBe("Run a script on Travel on Studio Mac");
    expect(rows[4]?.action).toBe("Run a script on Travel on Studio Mac");
    expect(operationRow(slot("waiting").operations![1]!).action).toBe(
      "Run a script on Shopping on Studio Mac",
    );
    expect(operationRow(slot("stopped").operations![1]!).action).toBe(
      "Run a script on Personal on Studio Mac",
    );
  });

  it("states an unknown outcome plainly, and a running one as running", () => {
    expect(rows[3]).toMatchObject({ outcome: { label: "Uncertain", tone: "warn" } });
    expect(rows[3]?.detail).toMatch(/can’t say whether this happened/u);
    expect(rows[4]).toMatchObject({ outcome: { label: "Running…", tone: "busy" }, detail: null });
  });

  it("says when you didn't allow it, when it waits for you, and an unfamiliar tool in plain language", () => {
    const [, refused] = slot("stopped").operations!.map(operationRow);
    expect(refused).toMatchObject({
      allowedBy: "You didn’t allow it",
      outcome: { label: "You didn’t allow it", tone: "muted" },
    });
    expect(operationRow(slot("waiting").operations![1]!)).toMatchObject({
      allowedBy: null,
      outcome: { label: "Waiting for you" },
    });
    const odd: AgentOperationView = { ...slot("working").operations![0]!, tool: "calendar_peek" };
    expect(operationRow(odd).action).toBe("Acted on Travel on Studio Mac");
    expect(
      operationRow({
        ...odd,
        decision: { by: "refused", reason: "authority", message: "Its grant changed." },
        outcome: "refused",
      }),
    ).toMatchObject({
      action: "Act on Travel on Studio Mac",
      allowedBy: "Not allowed: Its grant changed.",
      outcome: { label: "Not allowed", tone: "bad" },
    });
  });
});

describe("a tab a connected agent uses", () => {
  const occupant = { threadId: mockAgentWorkThreads.working, title: "Find flights to Lisbon" };
  it("says who is using it and for which task, and both when the person shares it", () => {
    expect(tabAgentLine({ occupant, slot: slot("working") })).toEqual({
      line: "Claude is using this page for “Find flights to Lisbon”",
      stop: { sessionId: slot("working").sessionId },
    });
    expect(tabAgentLine({ occupant, slot: slot("working"), sharedFromChrome: true })?.line).toBe(
      "You and Claude are using this page, for “Find flights to Lisbon”",
    );
    expect(
      tabAgentLine({ occupant: { ...occupant, title: " " }, slot: slot("working") })?.line,
    ).toBe("Claude is using this page");
  });
  it("says stopped after Stop, and nothing for a native task or an ended session", () => {
    expect(tabAgentLine({ occupant, slot: slot("stopped") })).toEqual({
      line: "Stopped by you",
      stop: null,
    });
    expect(tabAgentLine({ occupant, slot: slot("ended") })).toBeNull();
    expect(tabAgentLine({ occupant, slot: null })).toBeNull();
  });
});

describe("the Request a direct operation opens", () => {
  const request = seed.requests[mockAgentWorkThreads.waiting]![0]!;
  const session = slot("waiting");
  // The view reads only a settled Request's status and answer.
  const answered = (status: "fulfilled" | "declined" | "withdrawn", value?: string) =>
    ({
      ...request,
      status,
      response: value ? { kind: "form", answers: { "operation-decision": [value] } } : null,
    }) as unknown as typeof request;

  it("keeps the Home's question, the agent's words and the exact calls apart", () => {
    const view = operationRequestView({ request, session })!;
    expect(view.question).toBe("Run a script in Shopping?");
    expect(view.listTitle).toBe("Grok: Run a script in Shopping?");
    // Where it acts, from the Home's parts; the summary only restates the question.
    expect(view.context).toBe("Shopping · Studio Mac");
    expect(view.agentWords).toEqual({
      label: "Grok says:",
      text: "Buy the $12 phone case you asked for.",
    });
    expect(view.calls?.text).toContain("Place order");
    expect(view.answers).toEqual({
      fieldId: "operation-decision",
      allow: { label: "Allow once", value: "allow" },
      deny: { label: "Don’t allow", value: "deny" },
    });
    expect(view.after).toBe(
      "Grok is told your answer. Allowing this once doesn’t give it any more access.",
    );
  });

  it("takes a Request for an approval only when the Home names its decision field", () => {
    // The same two answers without the Home's operation parts: not an approval.
    expect(
      operationRequestView({ request: { ...request, agentOperation: undefined }, session }),
    ).toBeNull();
    expect(operationDecisionField({ ...request, agentOperation: undefined })).toBeNull();
    // The parts name a field the form doesn't have: not an approval either.
    expect(
      operationDecisionField({
        ...request,
        agentOperation: { ...request.agentOperation!, decisionFieldId: "elsewhere" },
      }),
    ).toBeNull();
    expect(operationDecisionField(request)).toBe("operation-decision");
  });

  it("says allowed, not allowed, expired and no longer needed", () => {
    expect(
      operationRequestView({ request: answered("fulfilled", "allow"), session }),
    ).toMatchObject({ state: "allowed", settled: "You allowed this once.", answers: null });
    expect(operationRequestView({ request: answered("fulfilled", "deny"), session })?.state).toBe(
      "denied",
    );
    expect(operationRequestView({ request: answered("declined"), session })?.settled).toBe(
      "You didn’t allow this.",
    );
    expect(
      operationRequestView({
        request: {
          ...answered("withdrawn"),
          agentOperation: { ...request.agentOperation!, expired: true },
        },
        session,
      })?.settled,
    ).toBe("This request expired. Grok was told no one answered.");
    expect(
      operationRequestView({
        request: answered("withdrawn"),
        session: { ...session, status: "ended", endReason: "stopped" },
      })?.settled,
    ).toBe("No longer needed: you stopped Grok.");
  });

  it("leaves every other Request alone", () => {
    expect(
      operationRequestView({
        request: { ...request, originatingAgentSessionId: null },
        session,
      }),
    ).toBeNull();
  });
});

describe("what the Home itself reports for an agent's own work", () => {
  const work = {
    sessionId: "ags_00000000-0000-4000-8000-000000000001",
    status: "ended" as const,
    endReason: "stopped" as const,
    connection: { id: "mcn_home", label: "Research agent", clientName: "Research" },
  };
  it("keeps a task the agent's after its session ends, and reads activity only once loaded", () => {
    const view = sessionTaskView({
      thread: { status: "idle", agentSessionId: null },
      slot: sessionSlotFromHome(work as never),
    });
    expect(view).toMatchObject({
      state: "stopped",
      stop: null,
      agent: { name: "Research agent" },
      activity: { kind: "unavailable" },
    });
    expect(
      sessionTaskView({
        thread: { status: "idle", agentSessionId: null },
        slot: sessionSlotFromHome(work as never, []),
      })?.activity,
    ).toEqual({ kind: "ready", rows: [] });
  });
  it("reads an operation's Request from its own parts, by the field the Home names", () => {
    const request = {
      id: "req_1",
      status: "cancelled" as const,
      originatingAgentSessionId: work.sessionId,
      agentOperation: {
        operationId: "aop_1",
        connectionId: "mcn_home",
        summary: "A connected agent wants to open a page in Work.",
        calls: "tab_open {}",
        agentReason: "To read the report",
        target: {
          grant: { kind: "browser-profile", profileId: "bpr_1" },
          name: "Work",
          device: null,
        },
        decisionFieldId: "choose",
        expired: true,
      },
      presentation: {
        kind: "form" as const,
        title: "Allow this?",
        fields: [
          {
            id: "choose",
            choices: [{ value: "yes" }, { value: "no" }],
          },
        ],
      },
    };
    const view = operationRequestView({
      request: request as never,
      session: sessionSlotFromHome(work as never),
    });
    expect(view).toMatchObject({
      summary: "A connected agent wants to open a page in Work.",
      agentWords: { text: "To read the report" },
      calls: { text: "tab_open {}" },
      state: "expired",
      agent: { name: "Research agent" },
    });
  });
});

describe("what a connected agent asks the person itself", () => {
  const asked = mockAgentWork({
    now,
    userId: "usr_0192f4a1-0000-4000-8000-000000000001",
    template: { id: "thr_00000000-0000-4000-8000-000000000001", title: "t" } as ThreadSummary,
    connections,
    question: true,
  });
  const question = asked.requests[mockAgentWorkThreads.working]![0]!;
  const operation = asked.requests[mockAgentWorkThreads.waiting]![0]!;

  it("is a question with its own choices, never a direct operation's Allow once", () => {
    // The Home records ask_person with its presentation and no operation parts.
    expect(question.agentOperation).toBeUndefined();
    expect(operationRequestView({ request: question })).toBeNull();
    expect(sessionQuestions([operation, question])).toEqual([question]);
    const asked = sessionQuestions([question])[0]!.presentation;
    if (asked.kind !== "form") throw new Error("not a form");
    expect(asked.fields[0]!.choices?.map(({ label }) => label)).toEqual([
      "Done",
      "Unable to do it",
    ]);
  });

  it("is a question in its own words even when the agent offers allow and deny", () => {
    if (question.presentation.kind !== "form") throw new Error("not a form");
    const field = question.presentation.fields[0]!;
    const lookalike = {
      ...question,
      presentation: {
        ...question.presentation,
        fields: [
          {
            ...field,
            choices: [
              { label: "allow", value: "allow" },
              { label: "deny", value: "deny" },
            ],
          },
        ],
      },
    };
    // Only the Home says a Request is an operation approval, never the look of its answers.
    expect(operationDecisionField(lookalike)).toBeNull();
    expect(operationRequestView({ request: lookalike })).toBeNull();
    expect(sessionQuestions([lookalike])).toEqual([lookalike]);
  });

  it("leaves an answered question and any other task's Request alone", () => {
    expect(sessionQuestions([{ ...question, status: "fulfilled" }])).toEqual([]);
    expect(sessionQuestions([{ ...question, originatingAgentSessionId: null }])).toEqual([]);
  });
});
