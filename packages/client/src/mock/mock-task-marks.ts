import {
  createId,
  MessageAuthorSchema,
  RequestSchema,
  type MarkColor,
  type WorkspaceIconName,
} from "@opensteer/core";
import type { HostSnapshot, ThreadSummary, WorkspaceSummary } from "../host/client.js";

/** The mock's one naming reply: an unclassified subject settles to `none`/document. */
export function mockGeneratedTaskIcon(text: string): WorkspaceIconName {
  const subjects: readonly [RegExp, WorkspaceIconName][] = [
    [/hotel|hyatt|room|booking/iu, "hotel"],
    [/table|restaurant|dinner/iu, "utensils"],
    [/flight|plane|airport/iu, "plane"],
    [/inbox|email|triage/iu, "inbox"],
    [/plumb|repair/iu, "wrench"],
    [/dentist|cleaning/iu, "stethoscope"],
    [/expense|receipt|reconcile/iu, "receipt"],
    [/sofa|loveseat|furniture/iu, "sofa"],
    [/gift|birthday/iu, "gift"],
    [/travel|trip|weekend/iu, "map"],
    [/code|architecture|portablefs/iu, "code"],
    [/launch/iu, "rocket"],
    [/statement|budget/iu, "wallet"],
    [/report/iu, "chart"],
    [/delivery/iu, "truck"],
    [/movie/iu, "film"],
    [/slack|assistant/iu, "chat"],
  ];
  return subjects.find(([pattern]) => pattern.test(text))?.[1] ?? "document";
}

/** Errands and specialists that exercise task marks alongside the existing demo journeys. */
export function seedMockTaskMarks(snapshot: HostSnapshot): HostSnapshot {
  const main = snapshot.workspaces[0]!;
  const template = snapshot.threads[0]!;
  const at = "2026-10-25T12:00:00.000Z";
  const specialists = [
    [
      "Travel",
      "luggage",
      "blue",
      "Plans trips: flights, hotels and day-by-day plans. Knows your seat and loyalty preferences.",
    ],
    ["Home", "house", "green", "Furniture, repairs and anything for the apartment."],
    ["Money", "wallet", "lime", "Expenses, receipts and monthly budget check-ins."],
    ["Health", "health", "magenta", "Appointments, prescriptions and insurance claims."],
  ] as const;
  const workspaces: WorkspaceSummary[] = specialists.map(
    ([name, icon, color, description], index) => ({
      ...main,
      id: `wsp_00000000-0000-4000-8000-${String(800 + index).padStart(12, "0")}`,
      kind: "specialized",
      homeThreadId: null,
      fileCount: 0,
      name,
      icon,
      color,
      description,
      updatedAt: at,
    }),
  );
  const specs: readonly {
    id: string;
    title: string;
    icon: WorkspaceIconName | null;
    color: MarkColor;
    specialist: number | null;
    status: ThreadSummary["status"];
    unread?: boolean;
    paused?: boolean;
  }[] = [
    {
      id: "7f3c91e2-4a10-4d7b-9a55-1f0c2e8b6a01",
      title: "Hyatt Seoul booking",
      icon: "hotel",
      color: "blue",
      specialist: 0,
      status: "waiting",
    },
    {
      id: "b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912",
      title: "Tokyo flights in May",
      icon: "plane",
      color: "lime",
      specialist: 0,
      status: "running",
    },
    {
      id: "0c94a6f1-2b7e-4c08-b3d9-5e61f2a87c34",
      title: "Weekly inbox triage",
      icon: "inbox",
      color: "magenta",
      specialist: null,
      status: "running",
    },
    {
      id: "e5d2b8a0-71c4-4e9f-a6b2-08d3f9c1e745",
      title: "find me a plumber who can come this week to fix the kitchen sink",
      icon: null,
      color: "teal",
      specialist: null,
      status: "running",
    },
    {
      id: "4a8f1c63-d05b-49e2-9f7a-c2b6e8014d58",
      title: "Dentist cleaning",
      icon: "stethoscope",
      color: "purple",
      specialist: 3,
      status: "waiting",
      paused: true,
    },
    {
      id: "93b7e2d5-6f18-4a3c-8d40-e1c5a7b92f69",
      title: "Q3 expense report",
      icon: "receipt",
      color: "green",
      specialist: 2,
      status: "failed",
    },
    {
      id: "1d6c4f8a-e29b-47d1-b5a3-9f02c8e6d17a",
      title: "Blue loveseat shortlist",
      icon: "sofa",
      color: "sky",
      specialist: 1,
      status: "idle",
      unread: true,
    },
    {
      id: "c8e03a91-5b6d-42f7-a1c9-4d7e2f8b03c6",
      title: "Mom's birthday gift ideas",
      icon: "gift",
      color: "blue",
      specialist: null,
      status: "idle",
    },
    {
      id: "5e2a9d07-c3f1-4b86-9e4d-a17f0c6b2e93",
      title: "Lisbon weekend plan",
      icon: "map",
      color: "lime",
      specialist: 0,
      status: "idle",
    },
    {
      id: "a9c4e1b6-07d2-4f35-8b9a-3e6d5f1c7a28",
      title: "Global Entry renewal",
      icon: "shield",
      color: "magenta",
      specialist: 0,
      status: "idle",
    },
  ];
  const threads: ThreadSummary[] = specs.map((spec, index) => ({
    ...template,
    id: `thr_${spec.id}`,
    title: spec.title,
    icon: spec.icon,
    color: spec.color,
    workspaceId: spec.specialist === null ? main.id : workspaces[spec.specialist]!.id,
    role: "work",
    listed: true,
    parentThreadId: null,
    pendingRequests: index === 0 ? 1 : 0,
    inputQueuePaused: spec.paused ?? false,
    status: spec.status,
    unread: spec.unread ?? false,
    createdAt: at,
    updatedAt:
      index >= 7
        ? "2026-10-21T12:00:00.000Z"
        : new Date(Date.parse(at) - index * 60_000).toISOString(),
  }));
  const requestTemplate = Object.values(snapshot.requests)
    .flat()
    .find(({ kind }) => kind === "harness.input")!;
  const hotel = threads[0]!;
  const request = RequestSchema.parse({
    ...requestTemplate,
    id: createId("request"),
    originatingThreadId: hotel.id,
    originatingWorkspaceId: hotel.workspaceId,
    targetWorkspaceId: hotel.workspaceId,
    originatingRunId: createId("run"),
    presentation: {
      kind: "choice",
      title: "Pick a room: King $212 or Twin $198",
      detail: "Both rooms include breakfast and free cancellation.",
      options: [
        { id: "king", label: "King $212", hint: "confirm" },
        { id: "twin", label: "Twin $198", hint: "confirm" },
      ],
      risk: "low",
    },
  });
  return {
    ...snapshot,
    workspaces: [...snapshot.workspaces, ...workspaces],
    workspaceWindow: {
      ...snapshot.workspaceWindow,
      itemCount: snapshot.workspaces.length + workspaces.length,
      totalItems: snapshot.workspaces.length + workspaces.length,
    },
    threads: [...snapshot.threads, ...threads],
    runQueue: [
      ...snapshot.runQueue,
      ...threads.flatMap((thread, index) =>
        thread.status === "running" || thread.status === "waiting"
          ? [
              {
                id: index === 0 ? request.originatingRunId! : createId("run"),
                threadId: thread.id,
                status: thread.status,
                runOrdinal: 1,
                createdAt: thread.createdAt,
              },
            ]
          : [],
      ),
    ],
    requests: { ...snapshot.requests, [hotel.id]: [request] },
    transcripts: {
      ...snapshot.transcripts,
      ...Object.fromEntries(
        threads.map((thread, index) => [
          thread.id,
          index === 6
            ? [
                {
                  kind: "message",
                  id: createId("message"),
                  runId: createId("run"),
                  createdAt: thread.updatedAt,
                  messageKind: "assistant",
                  body: "I found three blue loveseats that fit the apartment. The shortlist is ready.",
                  author: MessageAuthorSchema.parse({
                    kind: "agent",
                    threadId: thread.id,
                    runId: createId("run"),
                    workspaceId: thread.workspaceId,
                    workspaceName: "Home",
                    displayName: thread.title,
                  }),
                },
              ]
            : [],
        ]),
      ),
    },
  };
}
