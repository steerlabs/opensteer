import {
  createId,
  MessageAuthorSchema,
  RequestSchema,
  type MarkColor,
  type IconName,
} from "@opensteer/core";
import type { HostSnapshot, ThreadSummary } from "../host/client.js";

/** The mock's one naming reply: an unclassified subject settles to `none`/document. */
export function mockGeneratedTaskIcon(text: string): IconName {
  const subjects: readonly [RegExp, IconName][] = [
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
    [/code|architecture|storage/iu, "code"],
    [/launch/iu, "rocket"],
    [/statement|budget/iu, "wallet"],
    [/report/iu, "chart"],
    [/delivery/iu, "truck"],
    [/movie/iu, "film"],
    [/slack|assistant/iu, "chat"],
  ];
  return subjects.find(([pattern]) => pattern.test(text))?.[1] ?? "document";
}

/** Errands that exercise task marks alongside the existing demo journeys. */
export function seedMockTaskMarks<Snapshot extends HostSnapshot>(snapshot: Snapshot): Snapshot {
  const template = snapshot.threads[0]!;
  const at = "2026-10-25T12:00:00.000Z";
  const specs: readonly {
    id: string;
    title: string;
    icon: IconName | null;
    color: MarkColor;
    status: ThreadSummary["status"];
    unread?: boolean;
    paused?: boolean;
  }[] = [
    {
      id: "7f3c91e2-4a10-4d7b-9a55-1f0c2e8b6a01",
      title: "Hyatt Seoul booking",
      icon: "hotel",
      color: "blue",
      status: "waiting",
    },
    {
      id: "b21e07d4-9c3a-4f62-8e1d-73a5c0f4d912",
      title: "Tokyo flights in May",
      icon: "plane",
      color: "lime",
      status: "running",
    },
    {
      id: "0c94a6f1-2b7e-4c08-b3d9-5e61f2a87c34",
      title: "Weekly inbox triage",
      icon: "inbox",
      color: "magenta",
      status: "running",
    },
    {
      id: "e5d2b8a0-71c4-4e9f-a6b2-08d3f9c1e745",
      title: "find me a plumber who can come this week to fix the kitchen sink",
      icon: null,
      color: "teal",
      status: "running",
    },
    {
      id: "4a8f1c63-d05b-49e2-9f7a-c2b6e8014d58",
      title: "Dentist cleaning",
      icon: "stethoscope",
      color: "purple",
      status: "waiting",
      paused: true,
    },
    {
      id: "93b7e2d5-6f18-4a3c-8d40-e1c5a7b92f69",
      title: "Q3 expense report",
      icon: "receipt",
      color: "green",
      status: "failed",
    },
    {
      id: "1d6c4f8a-e29b-47d1-b5a3-9f02c8e6d17a",
      title: "Blue loveseat shortlist",
      icon: "sofa",
      color: "sky",
      status: "idle",
      unread: true,
    },
    {
      id: "c8e03a91-5b6d-42f7-a1c9-4d7e2f8b03c6",
      title: "Mom's birthday gift ideas",
      icon: "gift",
      color: "blue",
      status: "idle",
    },
    {
      id: "5e2a9d07-c3f1-4b86-9e4d-a17f0c6b2e93",
      title: "Lisbon weekend plan",
      icon: "map",
      color: "lime",
      status: "idle",
    },
    {
      id: "a9c4e1b6-07d2-4f35-8b9a-3e6d5f1c7a28",
      title: "Global Entry renewal",
      icon: "shield",
      color: "magenta",
      status: "idle",
    },
  ];
  const threads: ThreadSummary[] = specs.map((spec, index) => ({
    ...template,
    id: `thr_${spec.id}`,
    title: spec.title,
    icon: spec.icon,
    color: spec.color,
    purpose: "task",
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
