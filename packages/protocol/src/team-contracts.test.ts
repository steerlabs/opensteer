import { describe, expect, it } from "vitest";
import {
  createId,
  normalizeTeamHandle,
  parseTeamPageAppLink,
  parseTeamPageLink,
  teamAgentHandle,
  teamPageAppLink,
  teamPageUrl,
  uniqueTeamHandle,
  TeamStatusStepSchema,
  TeamMessageIdSchema,
} from "@opensteer/core";
import {
  acceptsTeamApiVersion,
  apiNegotiation,
  apiVersionHeader,
  hostApiCompatibility,
  hostApiVersion,
  minimumTeamApiVersion,
  teamApiVersion,
} from "@opensteer/deployment-authority";
import {
  TeamBinaryDownloadHeadersSchema,
  TeamLinkWebSocketHeadersSchema,
  TeamLinkClientFrameSchema,
  parseTeamLinkOffer,
  serializeTeamLinkOffer,
} from "./team-link.js";
import { NeedsYouEntrySchema } from "./needs-you.js";
import {
  TeamAgentRequestSchema,
  TeamChannelSummarySchema,
  TeamConsistentCutSchema,
} from "./team-chat.js";
import { hostApi } from "./host-api.js";
import { TeamCommandSchema } from "./team-api.js";
import {
  readTeamFrame,
  TeamClientFrameViewSchema,
  TeamLinkClientFrameViewSchema,
  TeamLinkServerFrameViewSchema,
  TeamServerFrameViewSchema,
} from "./team-views.js";

describe("team boundary contracts", () => {
  it("offers only the reusable invite lifetimes and use limits managers choose from", () => {
    const reset = (change: Record<string, unknown>) =>
      TeamCommandSchema.safeParse({
        type: "team.invite.reset",
        id: createId("teamInvite"),
        replaces: null,
        expiresInDays: 7,
        maxUses: null,
        ...change,
      }).success;
    for (const expiresInDays of [1, 7, 30]) expect(reset({ expiresInDays })).toBe(true);
    for (const expiresInDays of [0, 2, 14, 31, 365, "7"])
      expect(reset({ expiresInDays })).toBe(false);
    for (const maxUses of [null, 1, 1000]) expect(reset({ maxUses })).toBe(true);
    for (const maxUses of [0, -1, 1.5, 1001, undefined]) expect(reset({ maxUses })).toBe(false);
  });
  it("negotiates team independently of the personal epoch", () => {
    expect(apiNegotiation("personal")).toEqual({ kind: "personal", apiVersion: hostApiVersion });
    expect(apiNegotiation("team")).toEqual({ kind: "team", apiVersion: teamApiVersion });
    expect(apiVersionHeader("team")).toBe("x-opensteer-team-api-version");
    for (const personalEpoch of [1, hostApiVersion, hostApiVersion + 100])
      expect(
        hostApiCompatibility({
          kind: "team",
          apiVersion: teamApiVersion,
          hostApiVersion: personalEpoch,
        }),
      ).toBe("compatible");
    expect(hostApiCompatibility({ kind: "team", apiVersion: teamApiVersion + 1 })).toBe(
      "client-too-old",
    );
    expect(
      hostApiCompatibility({
        kind: "team",
        apiVersion: teamApiVersion + 1,
        minimumApiVersion: teamApiVersion,
      }),
    ).toBe("compatible");
    expect(
      hostApiCompatibility({
        kind: "team",
        apiVersion: teamApiVersion + 2,
        minimumApiVersion: teamApiVersion + 1,
      }),
    ).toBe("client-too-old");
    expect(hostApiCompatibility({ kind: "team" })).toBe("host-too-old");
    for (const stated of [String(minimumTeamApiVersion), teamApiVersion + 1, "999"])
      expect(acceptsTeamApiVersion(stated)).toBe(true);
    for (const stated of [undefined, "", "0", "01", "1.0", " 1", ["1"], minimumTeamApiVersion - 1])
      expect(acceptsTeamApiVersion(stated)).toBe(false);
    expect(hostApiCompatibility({ kind: "personal", apiVersion: hostApiVersion - 1 })).toBe(
      "host-too-old",
    );
  });
  it("preserves canonical invite fragments across both native app schemes", () => {
    const link = {
      origin: "https://team.example.invalid",
      target: { kind: "invite", selector: "s".repeat(24), verifier: "v".repeat(43) },
    } as const;
    expect(teamPageAppLink(link, "desktop")).toMatch(/^com\.opensteer\.opensteer:\/team\?/u);
    expect(teamPageAppLink(link, "mobile")).toMatch(/^com\.opensteer\.mobile:\/team\?/u);
    expect(parseTeamPageAppLink(teamPageAppLink(link, "desktop"), "desktop")).toEqual(link);
    expect(parseTeamPageAppLink(teamPageAppLink(link, "mobile"), "mobile")).toEqual(link);
    expect(parseTeamPageAppLink(teamPageAppLink(link, "desktop"), "mobile")).toBeNull();
    expect(parseTeamPageLink(teamPageUrl(link))).toEqual(link);
    expect(parseTeamPageLink(teamPageUrl(link).replace("https:", "http:"))).toBeNull();
    expect(
      parseTeamPageLink(`https://user:secret@team.example.invalid/c/${createId("teamChannel")}`),
    ).toBeNull();
    expect(
      parseTeamPageAppLink(
        "com.opensteer.mobile:/oauth/callback?url=https://team.example.invalid",
        "mobile",
      ),
    ).toBeNull();
  });
  it("uses positive bigint message IDs and rejects unknown team paths", () => {
    for (const invalid of ["not-a-number", "-1", "0", "01", "9223372036854775808", "1".repeat(100)])
      expect(TeamMessageIdSchema.safeParse(invalid).success).toBe(false);
    const channelId = createId("teamChannel");
    expect(
      parseTeamPageLink(`https://team.example.invalid/c/${channelId}/m/9223372036854775807`)?.target
        .kind,
    ).toBe("message");
    for (const path of [
      `/c/${channelId}/m/0`,
      `/c/${channelId}/m/9223372036854775808`,
      `/c/${channelId}/m/01`,
      `/c/${channelId}?secret=x`,
      `/teams/${createId("deployment")}`,
    ])
      expect(parseTeamPageLink(`https://team.example.invalid${path}`)).toBeNull();
  });
  it("normalizes handles once, resolves collisions, and reserves agent references", () => {
    expect(normalizeTeamHandle("  Máyà Chen  ")).toBe("maya-chen");
    expect(uniqueTeamHandle("Maya Chen", new Set(["maya-chen", "maya-chen-2"]))).toBe(
      "maya-chen-3",
    );
    expect(teamAgentHandle(normalizeTeamHandle("Maya"))).toBe("maya-agent");
    expect(normalizeTeamHandle("Maya Agent")).toBe("maya-agent-member");
    expect(normalizeTeamHandle("李")).toBe("member");
  });
  it("carries a one-time link code in a fragment and never accepts credential URLs", () => {
    const offer = {
      origin: "https://team.example.invalid",
      teamId: createId("deployment"),
      hostKeyFingerprint: "sha256:fixture",
      code: "c".repeat(43),
    };
    const text = serializeTeamLinkOffer(offer);
    expect(new URL(text).search).toBe("");
    expect(parseTeamLinkOffer(text)).toEqual(offer);
    expect(parseTeamLinkOffer(text.replace("https://", "https://user:secret@"))).toBeNull();
    expect(parseTeamLinkOffer(text + "&code=duplicate")).toBeNull();
  });
  it("refuses private status targets and keeps binary authority in headers", () => {
    expect(TeamStatusStepSchema.safeParse({ kind: "read_files", count: 2 }).success).toBe(true);
    for (const target of ["/Users/private/key", "#leadership", "credential=secret"]) {
      expect(TeamStatusStepSchema.safeParse({ kind: "read_files", count: 2, target }).success).toBe(
        false,
      );
      expect(TeamStatusStepSchema.safeParse({ kind: target, count: 1 }).success).toBe(false);
    }
    const headers = {
      "x-opensteer-team-api-version": "4",
      authorization: `Bearer ost_link_${"x".repeat(43)}`,
      "x-opensteer-team-request-id": createId("teamAgentRequest"),
      "x-opensteer-team-run-id": createId("run"),
      "x-opensteer-team-operation-id": "download-operation",
      "x-opensteer-team-blob-id": createId("teamBlob"),
      "x-opensteer-team-file-part": "original",
    };
    expect(TeamBinaryDownloadHeadersSchema.safeParse(headers).success).toBe(true);
    expect(
      TeamLinkWebSocketHeadersSchema.safeParse({
        "x-opensteer-team-api-version": headers["x-opensteer-team-api-version"],
        authorization: headers.authorization,
      }).success,
    ).toBe(true);
    expect(
      TeamBinaryDownloadHeadersSchema.safeParse({
        ...headers,
        "x-opensteer-team-request-id": undefined,
      }).success,
    ).toBe(true);
    expect(
      TeamBinaryDownloadHeadersSchema.safeParse({
        ...headers,
        "x-opensteer-team-run-id": undefined,
      }).success,
    ).toBe(false);
    expect(
      TeamLinkClientFrameSchema.safeParse({
        type: "read",
        id: "1",
        channelId: createId("teamChannel"),
      }).success,
    ).toBe(false);
  });
  it("resumes from an explicit consistent cut and keeps instructions out of directory summaries", () => {
    const channel = {
      id: createId("teamChannel"),
      kind: "private",
      name: "Research",
      peopleOnly: false,
      archivedAt: null,
      changeSeq: "17",
      latestMessageId: null,
      can: { read: true, post: true, manage: false, join: false, leave: true, wakeOwnAgent: true },
      instructionsMarkdown: "Read the channel context before replying.",
      instructionsRevision: "3",
    };
    const cut = {
      type: "resumed",
      subscriptionId: "channel",
      generation: 1,
      scope: { kind: "channel", channelId: channel.id },
      throughSeq: "30",
      channel,
      linkPresence: [],
      changedRows: [],
      deletedIds: [],
      requests: [],
    };
    expect(TeamConsistentCutSchema.safeParse(cut).success).toBe(true);
    expect(TeamConsistentCutSchema.safeParse({ ...cut, throughSeq: undefined }).success).toBe(
      false,
    );
    expect(TeamConsistentCutSchema.safeParse({ ...cut, channel: undefined }).success).toBe(false);
    expect(
      TeamConsistentCutSchema.safeParse({
        ...cut,
        deletedIds: Array.from({ length: 201 }, (_, i) => String(i + 1)),
      }).success,
    ).toBe(false);
    expect(TeamChannelSummarySchema.safeParse(channel).success).toBe(false);
  });
  it("reads a newer peer's frames: unknown fields are dropped and unknown frame types skipped", () => {
    const channelId = createId("teamChannel"),
      requestId = createId("teamAgentRequest");
    const newer = { future: { nested: true } };
    const cases = [
      [
        TeamServerFrameViewSchema,
        { type: "team.typing", channelId, rootId: null, userIds: [], ...newer },
      ],
      [TeamClientFrameViewSchema, { type: "team.presence", visible: true, watchedUserIds: [] }],
      [
        TeamLinkServerFrameViewSchema,
        { type: "result", id: "1", result: { kind: "receipt", messageId: null, ...newer } },
      ],
      [
        TeamLinkClientFrameViewSchema,
        {
          type: "status",
          id: "1",
          requestId,
          state: "working",
          steps: [{ kind: "read_files", count: 2, ...newer }],
          ...newer,
        },
      ],
    ] as const;
    for (const [schema, frame] of cases) {
      const read = readTeamFrame(schema, { ...frame, ...newer });
      expect(read).not.toBeNull();
      expect(JSON.stringify(read)).not.toContain("future");
      expect(readTeamFrame(schema, { type: "team.future", ...newer })).toBeNull();
      expect(() => readTeamFrame(schema, { type: frame.type })).toThrow();
    }
    expect(() =>
      readTeamFrame(TeamLinkClientFrameViewSchema, {
        type: "search",
        id: "1",
        requestId,
        input: { query: "plans", ...newer },
      }),
    ).toThrow();
  });
  it("removes old human commands and requires a channel-scoped send identity", () => {
    expect(
      hostApi["commands.dispatch"].payload.safeParse({ type: "workspace.create", name: "old" })
        .success,
    ).toBe(false);
    expect(
      hostApi["commands.dispatch"].payload.safeParse({ type: "thread.create", home: true }).success,
    ).toBe(false);
    expect(
      hostApi["commands.dispatch"].payload.safeParse({
        type: "team.message.send",
        channelId: createId("teamChannel"),
        threadRootId: null,
        clientMessageId: crypto.randomUUID(),
        bodyMarkdown: "Hi",
        mentions: [],
        attachmentIds: [],
      }).success,
    ).toBe(true);
  });
});

describe("team ask and private return contracts", () => {
  const teamId = createId("deployment"),
    channelId = createId("teamChannel");
  const root = TeamMessageIdSchema.parse("1"),
    requestId = createId("teamAgentRequest");
  const presentation = {
    asker: { teamUserId: createId("user"), displayName: "Maya", actor: "agent" as const },
    bodyMarkdown: "Review **this**",
    attachments: [],
    destination: { teamId, channelId, threadRootId: root },
    audience: {
      teamName: "Studio",
      channelName: "support",
      channelKind: "public" as const,
      memberCount: 2,
      peopleOnly: false,
    },
  };
  const request = {
    id: requestId,
    kind: "ask",
    consentExpiresAt: "2026-11-20T00:00:00.000Z",
    ownerUserId: createId("user"),
    channelId,
    threadRootId: root,
    triggerMessageId: root,
    state: "awaiting_approval",
    steps: [],
    createdAt: "2026-11-13T00:00:00.000Z",
    acceptedAt: null,
    expiresAt: null,
    finishedAt: null,
    replyMessageId: null,
    failureCode: null,
    changeSeq: "1",
  };
  it("keeps private resume attribution on the link and strips future nested presentation fields", () => {
    const payload = {
      originAskId: requestId,
      resumeRunId: createId("run"),
      outcome: "answered",
      bodyMarkdown: "Looks good",
      attachments: [],
    };
    const frame = TeamLinkServerFrameViewSchema.parse({
      type: "requests",
      requests: [
        {
          request: { ...request, presentation, returnPayload: payload },
          presentation: {
            ...presentation,
            asker: { ...presentation.asker, future: true },
            future: true,
          },
          returnPayload: null,
          source: { ...presentation.destination, messageId: root, audience: presentation.audience },
          bodyMarkdown: "Review **this**",
          attachments: [],
        },
        {
          request: { ...request, kind: "return", state: "queued", consentExpiresAt: null },
          presentation: null,
          returnPayload: { ...payload, future: true },
          source: { ...presentation.destination, messageId: root, audience: presentation.audience },
          bodyMarkdown: "Looks good",
          attachments: [],
        },
      ],
    });
    expect(frame.type).toBe("requests");
    if (frame.type !== "requests") throw new Error("Expected requests frame");
    expect(frame.requests[1]!.returnPayload).toEqual(payload);
    expect(frame.requests[0]!.presentation).toEqual(presentation);
    expect(frame.requests[0]!.request).not.toHaveProperty("presentation");
    expect(frame.requests[0]!.request).not.toHaveProperty("returnPayload");
    for (const extra of [{ returnPayload: payload }, { presentation }])
      expect(TeamAgentRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  });
  it("represents consent without a task or generic Request and carries explicit decisions and reconciliation", () => {
    const entry = NeedsYouEntrySchema.parse({
      kind: "team-ask",
      teamId,
      requestId,
      presentation,
      createdAt: request.createdAt,
      consentExpiresAt: request.consentExpiresAt,
    });
    expect(entry).not.toHaveProperty("request");
    expect(entry).not.toHaveProperty("navigationThreadId");
    for (const decision of ["approve", "decline"])
      expect(
        hostApi["commands.dispatch"].payload.parse({
          type: "teams.ask.decide",
          teamId,
          requestId,
          decision,
        }),
      ).toMatchObject({ decision });
    expect(
      TeamLinkClientFrameSchema.parse({
        type: "accept",
        id: "decision",
        requestId,
        decision: "decline",
      }),
    ).toHaveProperty("decision", "decline");
    expect(
      TeamLinkClientFrameSchema.parse({ type: "accept", id: "reconnect", requestId }),
    ).not.toHaveProperty("decision");
    expect(
      TeamLinkClientFrameViewSchema.parse({
        type: "reconcile",
        id: "reconcile",
        requestIds: [requestId],
      }),
    ).toHaveProperty("requestIds", [requestId]);
    const result = TeamLinkServerFrameViewSchema.parse({
      type: "result",
      id: "reconcile",
      result: { kind: "reconciled", requests: [{ requestId, request: null }] },
    });
    expect(result).toMatchObject({
      result: { kind: "reconciled", requests: [{ requestId, request: null }] },
    });
  });
});
