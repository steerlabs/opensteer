import {
  DeploymentIdSchema,
  KnowledgeNoteIdSchema,
  KnowledgeTopicIdSchema,
  TeamAgentRequestIdSchema,
  TeamGroupIdSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamHandleSchema,
  UserIdSchema,
  type KnowledgeTopicId,
  type TeamChannelId,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import {
  TeamAgentRequestSchema,
  TeamChannelSchema,
  TeamFileSchema,
  TeamGroupSchema,
  TeamMemberSchema,
  type TeamAgentRequest,
  type TeamMessage,
} from "@opensteer/protocol";
import type { MockTeamHost } from "../team/mock-team-host.js";
import type { z } from "zod";

/**
 * The preview's busy teams (`?mock-team=busy`): people, a long #support with
 * threads, files and every status card state, unread channels, mentions and
 * DMs, so screens and captures show what a real team looks like. Preview only.
 */
export const busyTeamIds = [
  DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
  DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000002"),
] as const;

type Kind = "public" | "private" | "dm" | "group_dm";
type File = z.infer<typeof TeamFileSchema>;

const userId = (n: number) =>
  UserIdSchema.parse(`usr_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const channelId = (team: number, n: number) =>
  TeamChannelIdSchema.parse(
    `tch_00000000-0000-4000-8${String(team)}00-${String(n).padStart(12, "0")}`,
  );

const people = [
  { id: 2, name: "Leo Park", handle: "leo" },
  { id: 3, name: "Maya Chen", handle: "maya" },
  { id: 4, name: "Dana Ortiz", handle: "dana" },
  { id: 5, name: "Priya Shah", handle: "priya" },
  { id: 6, name: "Sam Rivera", handle: "sam" },
  { id: 7, name: "Jordan Alexandria Whitfield-Nakamura", handle: "jordan" },
] as const;

const supportLines = [
  "Customer on 4411 says the lid arrived cracked. They want a refund.",
  "Shopify's refund API is flaky this morning. Use store credit if it fails.",
  "Carrier claim for 4398 went through.",
  "Can someone check why the **Berlin warehouse** shows 0 stock for the blue kettle?",
  "Looked: the sync job skipped it. Re-running now.",
  "Re-run done, stock is back at 214.",
  "Heads up: three tickets today about the new checkout coupon not applying.",
  "Coupon fix is in review. ETA after lunch.",
  "Order 4420 shipped to the old address; the customer moved last week.",
  "I'll call them and set up a reroute with the carrier.",
  "Reminder that returns over $500 need a second approval.",
  "Approved the return for 4402.",
  "Does anyone know the policy for opened bundles? The doc says one thing and the macro says another.",
  "The doc is right. I'll fix the macro.",
  "Weekly numbers: 312 tickets, median first reply 14m, CSAT 94%.",
  "Nice work everyone 🙌",
  "Customer asking if we ship to the Faroe Islands.",
  "We do, through the DK partner. Takes about 9 days.",
  "Added a saved reply for that.",
  "The packing slip PDF is cutting off long addresses again.",
];

const launchLines = [
  "Launch checklist is in the pinned message. Please claim your rows.",
  "Press kit is final.",
  "Landing page copy needs one more pass on the pricing section.",
  "I can take pricing.",
];

/**
 * Fixed identities and timestamps keep web and phone captures reproducible.
 */
export function seedBusyTeam(
  host: MockTeamHost,
  options: { readonly name: string; readonly index: 1 | 2 },
): void {
  const me = host.userId;
  host.bootstrap.teamName = options.name;
  host.bootstrap.member.displayName = "Tim Jang";
  host.bootstrap.member.handle = TeamHandleSchema.parse("tim");
  host.bootstrap.member.joinedAt = "2026-09-01T09:00:00.000Z";
  const members = [
    host.bootstrap.member,
    ...people.map((person) =>
      TeamMemberSchema.parse({
        userId: userId(person.id),
        displayName: person.name,
        handle: person.handle,
        image: null,
        role: person.id === 3 ? "admin" : "member",
        state: "active",
        generation: "1",
        joinedAt: "2026-09-01T09:00:00.000Z",
      }),
    ),
  ];
  host.members.splice(0, host.members.length, ...members);
  const requests = host.requests;
  host.linkPresence.push({ ownerUserId: userId(2), online: false });

  const general = [...host.channels.values()][0]!;
  const channel = (n: number, name: string, kind: Kind, extra: { peopleOnly?: boolean } = {}) => {
    const id = n === 1 ? general.id : channelId(options.index, n);
    host.channels.set(
      id,
      TeamChannelSchema.parse({
        ...general,
        id,
        name,
        kind,
        peopleOnly: extra.peopleOnly ?? false,
        can: { ...general.can, manage: kind === "public" || kind === "private" },
        instructionsMarkdown:
          name === "support"
            ? "Answer from the refund policy in Knowledge. Never promise a date the carrier hasn't confirmed."
            : "",
      }),
    );
    return id;
  };

  let clock = Date.parse("2026-11-08T08:30:00.000Z");
  const send = (
    where: TeamChannelId,
    author: UserId,
    body: string,
    shape: Partial<Pick<TeamMessage, "threadRootId" | "attachments" | "mentions" | "pinned">> & {
      readonly agentRequestId?: TeamMessage["agentRequestId"];
      readonly minutes?: number;
    } = {},
  ): TeamMessage => {
    clock += (shape.minutes ?? 7) * 60_000;
    return host.post({
      channelId: where,
      threadRootId: shape.threadRootId ?? null,
      clientMessageId: `00000000-0000-4000-8000-${String(host.messages.size + 1).padStart(12, "0")}`,
      bodyMarkdown: body,
      authorUserId: author,
      authorKind: shape.agentRequestId ? "agent" : "human",
      agentRequestId: shape.agentRequestId ?? null,
      createdAt: new Date(clock).toISOString(),
      attachments: shape.attachments ?? [],
      mentions: shape.mentions ?? [],
      pinned: shape.pinned ?? false,
    });
  };
  const file = (where: TeamChannelId, name: string, mediaType: string, size: number): File => {
    const value = TeamFileSchema.parse({
      id: TeamBlobIdSchema.parse(`tbl_00000000-0000-4000-8000-${String(size).padStart(12, "0")}`),
      channelId: where,
      filename: name,
      mediaType,
      sizeBytes: size,
      sha256: "0".repeat(64),
      preview: mediaType.startsWith("image/") ? { mediaType: "image/png", sizeBytes: 80 } : null,
    });
    host.files.set(value.id, {
      file: value,
      original: new Blob([previewPng()], { type: mediaType }),
      preview: mediaType.startsWith("image/")
        ? new Blob([previewPng()], { type: "image/png" })
        : null,
    });
    return value;
  };
  const ask = (
    owner: UserId,
    where: TeamChannelId,
    root: TeamMessage,
    trigger: TeamMessage,
    state: TeamAgentRequest["state"],
    extra: Partial<TeamAgentRequest> = {},
  ): TeamAgentRequest => {
    const request = TeamAgentRequestSchema.parse({
      id: TeamAgentRequestIdSchema.parse(
        `tar_00000000-0000-4000-8${options.index}00-${String(requests.length + 1).padStart(12, "0")}`,
      ),
      ownerUserId: owner,
      channelId: where,
      threadRootId: root.id,
      triggerMessageId: trigger.id,
      state,
      steps: [],
      createdAt: trigger.createdAt,
      acceptedAt: state === "queued" ? null : trigger.createdAt,
      expiresAt: null,
      finishedAt: null,
      replyMessageId: null,
      failureCode: null,
      changeSeq: trigger.changeSeq,
      ...extra,
    });
    return host.setRequest(request);
  };

  const people2 = people.map((person) => userId(person.id));
  const [leo, maya, dana, priya, sam, jordan] = people2 as [
    UserId,
    UserId,
    UserId,
    UserId,
    UserId,
    UserId,
  ];

  if (options.index === 2) {
    const family = channel(1, "family", "public");
    channel(2, "trip-planning", "public");
    for (const [author, body] of [
      [maya, "Who's bringing the tent?"],
      [leo, "I have it. Also the stove."],
      [me, "I'll do groceries Friday."],
    ] as const)
      send(family, author, body);
    markRead(host, family);
    const plans = send(channelId(2, 2), dana, "Train tickets are booked for the 14th.");
    send(channelId(2, 2), maya, `@Tim can you check the ferry times?`, {
      mentions: [{ userId: me, kind: "person" }],
    });
    void plans;
    seedFamilyKnowledge(host, { maya, leo, dana });
    return;
  }

  const announcements = channel(2, "announcements", "public");
  const launch = channel(3, "launch", "public");
  const support = channel(4, "support", "public");
  const leadership = channel(5, "leadership", "private");
  const design = channel(6, "design-crit", "public", { peopleOnly: true });
  const longName = channel(7, "q4-partner-integrations-and-marketplace-listing-review", "public");
  const dmMaya = channel(8, "Maya Chen", "dm");
  const dmGroup = channel(9, "Leo Park, Priya Shah", "group_dm");
  const dmJordan = channel(10, "Jordan Alexandria Whitfield-Nakamura", "dm");

  // #general: read.
  for (const [author, body] of [
    [maya, "Morning all. Standup moved to 10:15 today."],
    [sam, "Thanks for the heads up."],
    [priya, "Office wifi is back."],
  ] as const)
    send(general.id, author, body);
  markRead(host, general.id);

  // #announcements: read.
  send(announcements, maya, "**Holiday schedule** is posted. Support has coverage every day.", {
    pinned: true,
  });
  markRead(host, announcements);

  // #support: long, with threads, files, and every status card in one thread.
  const authors = [leo, maya, dana, priya, sam, me];
  let lastRead: TeamMessage | null = null;
  for (let index = 0; index < 236; index++) {
    const author = authors[(index * 7 + Math.floor(index / 3)) % authors.length]!;
    const message = send(support, author, supportLines[index % supportLines.length]!, {
      minutes: index % 37 === 0 ? 620 : 3 + (index % 11),
      ...(index % 41 === 5
        ? {
            attachments: [
              file(support, `refund-policy-v${index}.pdf`, "application/pdf", 182_400 + index),
            ],
          }
        : index % 53 === 17
          ? {
              attachments: [
                file(support, `damaged-lid-${index}.jpg`, "image/jpeg", 942_000 + index),
              ],
            }
          : {}),
    });
    if (index === 228) lastRead = message;
    if (index % 29 === 3) {
      for (let reply = 0; reply < 2 + (index % 3); reply++)
        send(support, authors[(index + reply + 1) % authors.length]!, "On it.", {
          threadRootId: message.id,
          minutes: 2,
        });
    }
  }
  if (lastRead) markRead(host, support, lastRead.id);

  const cracked = send(
    support,
    dana,
    "Customer on 4411 says the lid arrived cracked. They want a refund. Photos attached.",
    {
      attachments: [
        file(support, "lid-front.jpg", "image/jpeg", 1_204_000),
        file(support, "order-4411.csv", "text/csv", 3_100),
      ],
    },
  );
  const myAsk = send(support, me, "@My agent check 4411 and refund it if it's inside our policy", {
    threadRootId: cracked.id,
    mentions: [{ userId: me, kind: "agent" }],
    minutes: 5,
  });
  ask(me, support, cracked, myAsk, "working", {
    steps: [
      { kind: "read_files", count: 2 },
      { kind: "browsed", count: 3 },
    ],
  });
  const leoAsk = send(support, leo, "@leo-agent pull the carrier photos for the claim", {
    threadRootId: cracked.id,
    mentions: [{ userId: leo, kind: "agent" }],
    minutes: 2,
  });
  ask(leo, support, cracked, leoAsk, "queued");
  const danaAsk = send(support, dana, "@dana-agent draft the reply to the customer", {
    threadRootId: cracked.id,
    mentions: [{ userId: dana, kind: "agent" }],
    minutes: 1,
  });
  ask(dana, support, cracked, danaAsk, "needs_you", {
    steps: [
      { kind: "searched_team", count: 1 },
      { kind: "asked_you", count: 1 },
    ],
  });
  const priyaAsk = send(support, priya, "@priya-agent is 4411 inside the 30-day window?", {
    threadRootId: cracked.id,
    mentions: [{ userId: priya, kind: "agent" }],
    minutes: 1,
  });
  const priyaRequest = ask(priya, support, cracked, priyaAsk, "done", {
    steps: [{ kind: "searched_team", count: 2 }],
    finishedAt: new Date(clock + 60_000).toISOString(),
  });
  const reply = send(
    support,
    priya,
    "Yes: delivered Nov 2, so it's day 9 of 30. The policy covers a cracked lid with photos.",
    { threadRootId: cracked.id, agentRequestId: priyaRequest.id, minutes: 1 },
  );
  host.setRequest({ ...priyaRequest, replyMessageId: reply.id });
  const samAsk = send(support, sam, "@sam-agent open a carrier claim", {
    threadRootId: cracked.id,
    mentions: [{ userId: sam, kind: "agent" }],
    minutes: 1,
  });
  ask(sam, support, cracked, samAsk, "failed", {
    failureCode: "execution_failed",
    finishedAt: new Date(clock).toISOString(),
  });
  const mayaAsk = send(support, maya, "@maya-agent check the stock for a replacement lid", {
    threadRootId: cracked.id,
    mentions: [{ userId: maya, kind: "agent" }],
    minutes: 1,
  });
  ask(maya, support, cracked, mayaAsk, "stopped", {
    steps: [{ kind: "browsed", count: 2 }],
    finishedAt: new Date(clock).toISOString(),
  });
  send(support, leo, "@Tim the coupon fix is live, can you confirm on your side?", {
    mentions: [{ userId: me, kind: "person" }],
    minutes: 4,
  });
  const waiting = send(support, sam, "Refund for 4398 is stuck at the bank step.", {
    minutes: 3,
  });
  const mySecond = send(support, me, "@My agent find out why and fix it", {
    threadRootId: waiting.id,
    mentions: [{ userId: me, kind: "agent" }],
    minutes: 1,
  });
  ask(me, support, waiting, mySecond, "needs_you", { steps: [{ kind: "asked_you", count: 1 }] });

  // #launch: unread with a mention; #leadership private; a people-only channel; a long name.
  for (const [index, body] of launchLines.entries())
    send(launch, [maya, sam, priya, leo][index]!, body, { pinned: index === 0 });
  send(launch, maya, "@Tim can you review the pricing copy today?", {
    mentions: [{ userId: me, kind: "person" }],
  });
  send(leadership, maya, "Board deck draft is in the drive.");
  markRead(host, leadership);
  send(design, priya, "Onboarding v3 screens are up for crit at 3pm.");
  send(longName, jordan, "Marketplace listing review notes are attached.", {
    attachments: [
      file(
        longName,
        "marketplace-listing-review-final-v7-really-final.pdf",
        "application/pdf",
        88_100,
      ),
    ],
  });
  markRead(host, longName);

  // DMs: Maya with an unread message, a group DM, and a very long name.
  send(dmMaya, maya, "Got a minute to look at the refund macro?");
  send(dmGroup, leo, "Lunch at 12:30?");
  send(dmGroup, priya, "Yes please.");
  markRead(host, dmGroup);
  send(dmJordan, jordan, "Thanks for the intro!");
  markRead(host, dmJordan);

  seedAcmeKnowledge(host, {
    people: { me, leo, maya, dana, priya, sam, jordan },
    support,
    asks: { refund4411: myAsk, window4411: priyaAsk, bankStep: mySecond },
  });
}

const topicId = (team: number, n: number) =>
  KnowledgeTopicIdSchema.parse(`ktp_00000000-0000-4000-8${team}00-${String(n).padStart(12, "0")}`);
const noteId = (team: number, n: number) =>
  KnowledgeNoteIdSchema.parse(`knt_00000000-0000-4000-8${team}00-${String(n).padStart(12, "0")}`);
const day = (date: string, time = "10:00") => new Date(`${date}T${time}:00.000Z`).toISOString();

type Writer = { readonly userId: UserId; readonly agent?: boolean };

/** Writes a note's versions, oldest first, as their writers saved them. */
function seedNote(
  host: MockTeamHost,
  id: ReturnType<typeof noteId>,
  topic: KnowledgeTopicId,
  versions: readonly {
    readonly by: Writer;
    readonly at: string;
    readonly title?: string;
    readonly body?: string;
    readonly deleted?: boolean;
    readonly source?: { readonly channelId: TeamChannelId; readonly messageId: TeamMessageId };
  }[],
): void {
  let title = "";
  let body = "";
  for (const version of versions) {
    title = version.title ?? title;
    body = version.body ?? body;
    const member = host.members.find((row) => row.userId === version.by.userId);
    host.knowledge.addVersion({
      noteId: id,
      topicId: topic,
      title,
      body,
      deleted: version.deleted ?? false,
      at: version.at,
      writer: {
        kind: version.by.agent ? "agent" : "human",
        userId: version.by.userId,
        name: member?.displayName ?? "Someone",
      },
      source: version.by.agent ? (version.source ?? null) : null,
    });
  }
}

const customers = [
  ["Harbor & Pine Coffee", "Wholesale, 40 kettles a quarter. Prefers invoices on the 1st."],
  ["Juniper Studio", "Design studio in Lisbon. Ships to the office, not the founder's home."],
  ["Kettle Club Berlin", "Subscription box partner. Their API key rotates every 90 days."],
  ["Morrow Hotels", "Six properties. Damage claims go to their facilities lead, not reception."],
  ["Northwind Outfitters", "Outdoor retailer. Wants the matte black lid only."],
  ["Oak & Ember", "Restaurant group. Delivery window 7–9am, loading dock on Rue Saint-Paul."],
  ["Pebble Workspace", "Coworking chain. Pays by card; receipts to accounts@."],
  ["Quietwater Spa", "Asked about bulk engraving. Quote sent Oct 30."],
] as const;

function seedAcmeKnowledge(
  host: MockTeamHost,
  refs: {
    readonly people: Readonly<
      Record<"me" | "leo" | "maya" | "dana" | "priya" | "sam" | "jordan", UserId>
    >;
    readonly support: TeamChannelId;
    readonly asks: Readonly<Record<"refund4411" | "window4411" | "bankStep", TeamMessage>>;
  },
): void {
  const { me, leo, maya, dana, priya, sam, jordan } = refs.people;
  const groupId = (n: number) =>
    TeamGroupIdSchema.parse(`tgr_00000000-0000-4000-8100-${String(n).padStart(12, "0")}`);
  const supportTeam = TeamGroupSchema.parse({
    id: groupId(1),
    name: "Support team",
    people: [me, leo, dana, sam],
    children: [],
    updatedAt: day("2026-09-02"),
  });
  const design = TeamGroupSchema.parse({
    id: groupId(2),
    name: "Design",
    people: [priya, jordan],
    children: [],
    updatedAt: day("2026-09-02"),
  });
  host.groups.set(supportTeam.id, supportTeam);
  host.groups.set(design.id, design);
  const source = (ask: TeamMessage) => ({ channelId: refs.support, messageId: ask.id });
  const general = host.knowledge.starterTopicId;
  const [customersTopic, playbook, leadership, interviews, launch] = [1, 2, 3, 4, 5].map((n) =>
    topicId(1, n),
  ) as [KnowledgeTopicId, KnowledgeTopicId, KnowledgeTopicId, KnowledgeTopicId, KnowledgeTopicId];
  host.knowledge.addTopic({
    id: customersTopic,
    name: "Customers",
    description: "Who our customers are, what they bought and what they asked for.",
    access: [
      { subject: { kind: "everyone" }, level: "read" },
      { subject: { kind: "group", groupId: supportTeam.id }, level: "write" },
      { subject: { kind: "person", userId: dana }, level: "manage" },
    ],
    createdBy: maya,
    at: day("2026-09-03"),
  });
  host.knowledge.addTopic({
    id: playbook,
    name: "Support playbook",
    description: "How we handle refunds, claims and the tickets that keep coming back.",
    access: [{ subject: { kind: "group", groupId: supportTeam.id }, level: "write" }],
    createdBy: dana,
    at: day("2026-09-04"),
  });
  host.knowledge.addTopic({
    id: leadership,
    name: "Leadership",
    description: "Board prep, hiring and plans that aren't ready to share.",
    access: [
      { subject: { kind: "person", userId: me }, level: "manage" },
      { subject: { kind: "person", userId: priya }, level: "write" },
      { subject: { kind: "person", userId: jordan }, level: "read" },
    ],
    createdBy: maya,
    at: day("2026-09-05"),
  });
  host.knowledge.addTopic({
    id: interviews,
    name: "Interview notes",
    description: "Candidate feedback. Only the hiring panel reads it.",
    access: [{ subject: { kind: "person", userId: dana }, level: "read" }],
    createdBy: maya,
    at: day("2026-10-01"),
  });
  host.knowledge.addTopic({
    id: launch,
    name: "Q3 launch",
    description: "The kettle v2 launch: checklist, press and what we learned.",
    access: [{ subject: { kind: "everyone" }, level: "read" }],
    createdBy: sam,
    at: day("2026-07-01"),
    archivedAt: day("2026-10-20"),
  });

  let n = 0;
  const note = () => noteId(1, ++n);
  seedNote(host, note(), general, [
    {
      by: { userId: priya },
      at: day("2026-11-03", "09:12"),
      title: "Office wifi",
      body: "Network **Acme-Staff**, password on the card by the kitchen.\n\nGuests use **Acme-Guest**; it resets every Monday.",
    },
  ]);
  seedNote(host, note(), general, [
    {
      by: { userId: maya },
      at: day("2026-10-14", "15:40"),
      title: "Standup",
      body: "Daily at 10:00 in the big room, 15 minutes. Async updates in #announcements when you're out.",
    },
    {
      by: { userId: maya, agent: true },
      at: day("2026-11-08", "08:50"),
      body: "Daily at **10:15** in the big room, 15 minutes (moved from 10:00 in November).\n\nAsync updates in #announcements when you're out.",
    },
  ]);
  seedNote(host, note(), general, [
    {
      by: { userId: me },
      at: day("2026-09-20", "11:00"),
      title: "Where things live",
      body: "- Contracts and invoices: the shared drive, *Finance* folder\n- Brand assets: Figma, *Acme Brand* file\n- Shipping labels: the carrier portal (ask Sam for access)",
    },
  ]);

  seedNote(host, note(), customersTopic, [
    {
      by: { userId: dana },
      at: day("2026-11-08", "11:44"),
      title: "Order 4411 — cracked lid",
      body: "Customer reported a cracked lid on arrival, with photos.",
    },
    {
      by: { userId: me, agent: true },
      at: day("2026-11-12", "09:20"),
      body: "Customer reported a cracked lid on arrival, with photos.\n\n- Delivered **Nov 2**; day 9 of the 30-day window\n- Refunded **$64.00** to the original card on Nov 12\n- Replacement lid not needed; customer kept the kettle",
      source: source(refs.asks.refund4411),
    },
  ]);
  seedNote(host, note(), customersTopic, [
    {
      by: { userId: priya, agent: true },
      at: day("2026-11-09", "12:03"),
      title: "Order 4411 — refund window",
      body: "Delivered Nov 2, so the 30-day window ends **Dec 2**. A cracked lid with photos is covered.",
      source: source(refs.asks.window4411),
    },
  ]);
  seedNote(host, note(), customersTopic, [
    {
      by: { userId: sam },
      at: day("2026-11-07", "16:30"),
      title: "Order 4420 — reroute",
      body: "Shipped to the customer's old address. Called them and set up a reroute with the carrier; new ETA Nov 11.",
    },
  ]);
  const start = Date.parse("2026-10-01T09:00:00.000Z");
  for (let index = 0; index < 52; index++) {
    const [name, detail] = customers[index % customers.length]!;
    const writer = [leo, dana, sam, me][index % 4]!;
    seedNote(host, note(), customersTopic, [
      {
        by: { userId: writer, agent: index % 3 === 0 },
        at: new Date(start + index * 13 * 3_600_000).toISOString(),
        title: index < customers.length ? name : `${name} — order ${4300 + index}`,
        body:
          index < customers.length
            ? `${detail}\n\nAccount owner: ${["Leo", "Dana", "Sam", "Tim"][index % 4]}.`
            : `Order ${4300 + index} shipped ${index % 2 ? "on time" : "a day late"}. ${detail}`,
      },
    ]);
  }

  seedNote(host, note(), playbook, [
    {
      by: { userId: dana },
      at: day("2026-09-10", "10:00"),
      title: "Refunds over $500",
      body: "Need a second approval from Maya.",
    },
    {
      by: { userId: leo },
      at: day("2026-10-02", "14:10"),
      body: "Need a second approval from **Maya or Dana** before you refund.",
    },
    {
      by: { userId: me, agent: true },
      at: day("2026-11-09", "13:05"),
      body: "Need a second approval from **Maya or Dana** before you refund.\n\n1. Check the order is inside the 30-day window\n2. Ask in #support with the order number\n3. Refund to the original card; use store credit if Shopify's refund API fails\n\nIf a refund sits at the bank step for more than a day, open a ticket with the payment processor.",
      source: source(refs.asks.bankStep),
    },
  ]);
  seedNote(host, note(), playbook, [
    {
      by: { userId: dana },
      at: day("2026-10-20", "09:30"),
      title: "Opened bundles",
      body: "Opened bundles can be returned within 14 days for store credit.",
    },
    {
      by: { userId: dana },
      at: day("2026-11-08", "11:20"),
      body: "Opened bundles can be returned within **30 days** for a refund, minus the shipping cost. The old macro said 14 days; it's fixed.",
    },
  ]);
  seedNote(host, note(), playbook, [
    {
      by: { userId: sam, agent: true },
      at: day("2026-11-06", "15:00"),
      title: "Carrier claims",
      body: "File within 7 days of delivery on the carrier portal with:\n\n- photos of the box and the damage\n- the order number and tracking number\n\nClaims usually settle in 5–10 business days.",
    },
  ]);
  seedNote(host, note(), playbook, [
    {
      by: { userId: leo },
      at: day("2026-10-28", "12:00"),
      title: "Coupon workaround",
      body: "If KETTLE10 doesn't apply at checkout, refund 10% by hand after the order ships.",
    },
    { by: { userId: leo }, at: day("2026-11-08", "13:30"), deleted: true },
  ]);

  seedNote(host, note(), leadership, [
    {
      by: { userId: maya },
      at: day("2026-11-04", "17:00"),
      title: "Board meeting prep",
      body: "Deck draft is in the drive. Numbers to update: Q3 revenue, CSAT (94%), headcount plan.",
    },
  ]);
  seedNote(host, note(), leadership, [
    {
      by: { userId: priya },
      at: day("2026-10-25", "10:30"),
      title: "Q1 hiring plan",
      body: "Two support hires in January, one designer in March. Budget approved.",
    },
  ]);
  seedNote(host, note(), interviews, [
    {
      by: { userId: dana },
      at: day("2026-10-10", "16:00"),
      title: "Support lead candidates",
      body: "Shortlist of three. Panel notes to follow.",
    },
  ]);
  seedNote(host, note(), launch, [
    {
      by: { userId: sam },
      at: day("2026-09-30", "18:00"),
      title: "Launch retro",
      body: "**Went well:** press kit, landing page.\n\n**Next time:** start the carrier conversations two weeks earlier.",
    },
  ]);
}

/** The family team: Tim is a member there, so its topics show what a reader sees. */
function seedFamilyKnowledge(
  host: MockTeamHost,
  people: Readonly<Record<"maya" | "leo" | "dana", UserId>>,
): void {
  host.bootstrap.member.role = "member";
  host.bootstrap.can = {
    ...host.bootstrap.can,
    manageMembers: false,
    manageGroups: false,
    manageInvites: false,
    transferOwner: false,
    viewAudit: false,
  };
  const owner = host.members.find((member) => member.userId === people.maya);
  if (owner) owner.role = "owner";
  const house = topicId(2, 1);
  host.knowledge.addTopic({
    id: house,
    name: "House",
    description: "Bills, appliances and who to call.",
    access: [
      { subject: { kind: "everyone" }, level: "read" },
      { subject: { kind: "person", userId: people.leo }, level: "write" },
    ],
    createdBy: people.maya,
    at: day("2026-09-02"),
  });
  seedNote(host, noteId(2, 1), house, [
    {
      by: { userId: people.leo },
      at: day("2026-10-12", "19:00"),
      title: "Boiler service",
      body: "Serviced every October by Nordic Heating. Next visit booked for **Oct 2027**.",
    },
  ]);
  seedNote(host, noteId(2, 2), host.knowledge.starterTopicId, [
    {
      by: { userId: people.dana, agent: true },
      at: day("2026-11-01", "08:00"),
      title: "Trip packing list",
      body: "- Tent and stove (Leo)\n- Groceries (Tim, Friday)\n- Ferry tickets",
    },
  ]);
}

function markRead(host: MockTeamHost, where: TeamChannelId, through?: string): void {
  const latest = through ?? host.channels.get(where)?.latestMessageId;
  if (!latest) return;
  host.markRead(where, latest);
}

let png: Uint8Array<ArrayBuffer> | null = null;
/** A 2×2 picture: enough for a thumbnail to show without shipping one. */
function previewPng(): Uint8Array<ArrayBuffer> {
  png ??= Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR42mO4tqRi2qoTDBXTek7sWwUANkYHxQQrKpQAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  return png;
}
