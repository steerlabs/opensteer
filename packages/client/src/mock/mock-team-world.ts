import {
  DeploymentIdSchema,
  TeamAgentRequestIdSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamHandleSchema,
  UserIdSchema,
  type TeamChannelId,
  type UserId,
} from "@opensteer/core";
import {
  TeamAgentRequestSchema,
  TeamChannelSchema,
  TeamFileSchema,
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
