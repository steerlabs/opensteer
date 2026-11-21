import { readFileSync, writeFileSync } from "node:fs";
import {
  HostDescriptorBaseSchema,
  minimumTeamApiVersion,
  teamApiVersion,
} from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  json,
  wireUnionMembers,
  same,
  surfaceBreaks,
  wireBreaks,
  type JsonSchema,
  type Surface,
} from "./wire-compatibility.test-support.js";
import { hostApi } from "./host-api.js";
import { teamIdentityRpcNames, teamReadSchemas, TeamCommandSchema } from "./team-api.js";
import { TeamClientFrameSchema, TeamServerFrameSchema } from "./team-chat.js";
import {
  TeamInvitePreviewRequestSchema,
  TeamInvitePreviewResponseSchema,
  TeamSessionExchangeRequestSchema,
  TeamSessionExchangeResponseSchema,
} from "./team-session.js";
import {
  TeamBinaryDownloadHeadersSchema,
  TeamBinaryUploadHeadersSchema,
  TeamBinaryUploadMetadataSchema,
  TeamLinkClientFrameSchema,
  TeamLinkRedeemSchema,
  TeamLinkServerFrameSchema,
  TeamLinkViewSchema,
  TeamLinkWebSocketHeadersSchema,
} from "./team-link.js";
import {
  TeamPartnerChallengeSchema,
  TeamPartnerControlSchema,
  TeamPartnerHelloSchema,
  TeamPartnerOfferSchema,
  TeamPartnerProofSchema,
  TeamPartnerReadySchema,
  teamPartnerProtocolVersion,
} from "./team-partner.js";
import {
  TeamPartnerDataFrameSchema,
  TeamPartnerFrameViewSchema,
  TeamShareBatchSchema,
  TeamShareBatchViewSchema,
  TeamShareFileChunkSchema,
  TeamShareFileChunkViewSchema,
  TeamShareOperationSchema,
  TeamShareReceiptSchema,
  TeamShareReceiptViewSchema,
} from "./team-share.js";
import {
  readTeamFrame,
  TeamClientFrameViewSchema,
  TeamLinkClientFrameViewSchema,
  TeamLinkServerFrameViewSchema,
  TeamServerFrameViewSchema,
} from "./team-views.js";

interface TeamWire {
  readonly teamApiVersion: number;
  readonly minimumTeamApiVersion: number;
  /**
   * Requests the team Host parses strictly. A client sends a new input only
   * when the team advertises it, so only an older sender matters.
   */
  readonly input: Readonly<Record<string, JsonSchema>>;
  /** Replies, read by clients and personal Opensteer from a team older or newer than them. */
  readonly output: Readonly<Record<string, JsonSchema>>;
  /** Read in both directions by peers of either age; readers skip unknown frame types. */
  readonly frames: Readonly<Record<string, JsonSchema>>;
}

/** Team servers talking to each other, versioned apart from the team-client API. */
interface PartnerWire extends Pick<TeamWire, Surface> {
  readonly teamPartnerProtocolVersion: number;
}

const snapshotPath = new URL("./team-wire.snapshot.json", import.meta.url);
const partnerSnapshotPath = new URL("./team-partner-wire.snapshot.json", import.meta.url);
const updateVariable = "OPENSTEER_UPDATE_TEAM_WIRE";

function teamWire(): TeamWire {
  // Only what a team Host serves: `teams.*` entries are the personal Host's own routes.
  const commands = new Set<string>([
    ...TeamCommandSchema.options
      .map((option) => option.shape.type.value)
      .filter((type) => type.startsWith("team.")),
    "notification.preview.register",
  ]);
  const commandOptions = (union: z.ZodType) =>
    Object.fromEntries(
      wireUnionMembers(union).flatMap((option) => {
        const [type] = option._zod.propValues?.type ?? [];
        return typeof type === "string" && commands.has(type)
          ? [[`command ${type}`, json(option)]]
          : [];
      }),
    );
  const rpcs = [
    ...Object.keys(teamReadSchemas).filter((name) => name.startsWith("team.")),
    ...teamIdentityRpcNames,
  ] as const;
  const declaration = (name: string) => hostApi[name as keyof typeof hostApi];
  return {
    teamApiVersion,
    minimumTeamApiVersion,
    input: {
      ...Object.fromEntries(rpcs.map((name) => [`rpc ${name}`, json(declaration(name).payload)])),
      ...commandOptions(hostApi["commands.dispatch"].payload),
      "link redeem": json(TeamLinkRedeemSchema),
      "link socket headers": json(TeamLinkWebSocketHeadersSchema),
      "link download headers": json(TeamBinaryDownloadHeadersSchema),
      "link upload headers": json(TeamBinaryUploadHeadersSchema),
      "link upload metadata": json(TeamBinaryUploadMetadataSchema),
      "session exchange": json(TeamSessionExchangeRequestSchema),
      "invite preview": json(TeamInvitePreviewRequestSchema),
    },
    output: {
      ...Object.fromEntries(rpcs.map((name) => [`rpc ${name}`, json(declaration(name).success)])),
      ...commandOptions(hostApi["commands.dispatch"].success),
      "link view": json(TeamLinkViewSchema),
      "session exchange": json(TeamSessionExchangeResponseSchema),
      "invite preview": json(TeamInvitePreviewResponseSchema),
      // Strict: a signed discovery document is verified over exactly what was signed.
      descriptor: json(HostDescriptorBaseSchema),
    },
    frames: Object.fromEntries(
      Object.entries(frameViews).map(([surface, [, view]]) => [surface, json(view)]),
    ),
  };
}

function partnerWire(): PartnerWire {
  return {
    teamPartnerProtocolVersion,
    // A server sends a new request field only when its partner advertises it.
    input: Object.fromEntries(
      TeamShareOperationSchema.options.map((option) => [
        `operation ${option.shape.op.value}`,
        json(option),
      ]),
    ),
    output: {
      "pull result": json(TeamShareBatchViewSchema),
      "write receipt": json(TeamShareReceiptViewSchema),
      "file chunk": json(TeamShareFileChunkViewSchema),
      // Strict: the pairing offer and handshake change only with the protocol version.
      offer: json(TeamPartnerOfferSchema),
      hello: json(TeamPartnerHelloSchema),
      challenge: json(TeamPartnerChallengeSchema),
      proof: json(TeamPartnerProofSchema),
      ready: json(TeamPartnerReadySchema),
    },
    frames: { "partner frame": json(partnerFrameViews["partner frame"][1]) },
  };
}

/** What each side writes, and the view its peer reads it with. */
const frameViews = {
  "realtime client frame": [TeamClientFrameSchema, TeamClientFrameViewSchema],
  "realtime server frame": [TeamServerFrameSchema, TeamServerFrameViewSchema],
  "link client frame": [TeamLinkClientFrameSchema, TeamLinkClientFrameViewSchema],
  "link server frame": [TeamLinkServerFrameSchema, TeamLinkServerFrameViewSchema],
} as const;
const partnerFrameViews = {
  "partner frame": [
    z.discriminatedUnion("type", [
      ...TeamPartnerDataFrameSchema.options,
      ...TeamPartnerControlSchema.options,
    ]),
    TeamPartnerFrameViewSchema,
  ],
  "partner pull result": [TeamShareBatchSchema, TeamShareBatchViewSchema],
  "partner write receipt": [TeamShareReceiptSchema, TeamShareReceiptViewSchema],
  "partner file chunk": [TeamShareFileChunkSchema, TeamShareFileChunkViewSchema],
} as const;

const ignoringStrictness = (schema: JsonSchema): unknown =>
  JSON.parse(
    JSON.stringify(schema, (key, value: unknown) =>
      key === "additionalProperties" && value === false ? undefined : value,
    ),
  );

describe("team wire compatibility", () => {
  it("changes the team wire only additively unless teamApiVersion moves", () => {
    const committed = JSON.parse(readFileSync(snapshotPath, "utf8")) as TeamWire;
    const current = teamWire();
    expect(minimumTeamApiVersion).toBeLessThanOrEqual(teamApiVersion);
    expect(teamApiVersion).toBeGreaterThanOrEqual(committed.teamApiVersion);
    if (committed.teamApiVersion === teamApiVersion)
      expect(
        wireBreaks(committed, current),
        "This breaks peers on the same teamApiVersion. Make it additive, or bump teamApiVersion and decide minimumTeamApiVersion.",
      ).toEqual([]);
    if (process.env[updateVariable] === "1")
      writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
    else
      expect(
        same(current, committed),
        `The team wire changed compatibly. Record it with ${updateVariable}=1 pnpm exec vitest run packages/protocol/src/team-wire.test.ts`,
      ).toBe(true);
  });

  it("changes the partner wire only additively unless teamPartnerProtocolVersion moves", () => {
    const committed = JSON.parse(readFileSync(partnerSnapshotPath, "utf8")) as PartnerWire;
    const current = partnerWire();
    expect(teamPartnerProtocolVersion).toBeGreaterThanOrEqual(committed.teamPartnerProtocolVersion);
    if (committed.teamPartnerProtocolVersion === teamPartnerProtocolVersion)
      expect(
        wireBreaks(committed, current),
        "This breaks partner teams on the same protocol version. Make it additive, or bump teamPartnerProtocolVersion.",
      ).toEqual([]);
    if (process.env[updateVariable] === "1")
      writeFileSync(partnerSnapshotPath, `${JSON.stringify(current, null, 2)}\n`);
    else
      expect(
        same(current, committed),
        `The partner wire changed compatibly. Record it with ${updateVariable}=1 pnpm exec vitest run packages/protocol/src/team-wire.test.ts`,
      ).toBe(true);
  });

  it("reads every frame and partner result with a view that accepts exactly what its writer sends", () => {
    for (const [surface, [writer, view]] of Object.entries({ ...frameViews, ...partnerFrameViews }))
      expect(ignoringStrictness(json(view)), surface).toEqual(ignoringStrictness(json(writer)));
  });

  it("skips partner frames it does not know and drops fields it does not know", () => {
    const shareId = "00000000-0000-4000-8000-000000000001";
    expect(readTeamFrame(TeamPartnerFrameViewSchema, { type: "share.future", shareId })).toBeNull();
    expect(
      readTeamFrame(TeamPartnerFrameViewSchema, {
        type: "share.changed",
        shareId,
        generation: 1,
        future: true,
      }),
    ).toEqual({ type: "share.changed", shareId, generation: 1 });
  });

  it("tells additive changes from breaking ones on each surface", () => {
    const strict = z.strictObject({ id: z.string(), kind: z.enum(["a", "b"]) });
    const tolerant = z.object({ id: z.string(), note: z.string().optional() });
    const breaks = (before: z.ZodType, after: z.ZodType, surface: Surface) =>
      surfaceBreaks(json(before), json(after), surface);
    const optional = strict.extend({ note: z.string().optional() });
    expect(breaks(strict, optional, "input")).toEqual([]);
    expect(breaks(strict, optional, "output")).not.toEqual([]);
    expect(breaks(strict, strict.omit({ kind: true }), "input")).not.toEqual([]);
    expect(breaks(strict, strict.extend({ id: z.string().max(4) }), "input")).not.toEqual([]);
    const widened = strict.extend({ kind: z.enum(["a", "b", "c"]) });
    expect(breaks(strict, widened, "input")).toEqual([]);
    expect(breaks(strict, widened, "output")).not.toEqual([]);
    expect(breaks(strict.nullable(), optional.nullable(), "input")).toEqual([]);

    const frame = (shape: z.ZodRawShape = {}) => z.object({ type: z.literal("one"), ...shape });
    const frames = (...members: [z.ZodObject, ...z.ZodObject[]]) =>
      z.discriminatedUnion("type", [frame(tolerant.shape), ...members]);
    const base = frames(z.object({ type: z.literal("two"), at: z.string() }));
    for (const surface of ["output", "frames"] as const) {
      expect(breaks(tolerant, tolerant.extend({ more: z.string().optional() }), surface)).toEqual(
        [],
      );
      expect(breaks(tolerant, tolerant.extend({ more: z.string() }), surface)).not.toEqual([]);
      expect(breaks(tolerant, tolerant.extend({ note: z.string() }), surface)).not.toEqual([]);
      expect(breaks(tolerant, tolerant.omit({ note: true }), surface)).not.toEqual([]);
      expect(
        breaks(
          tolerant,
          tolerant.omit({ note: true }).extend({ memo: z.string().optional() }),
          surface,
        ),
      ).not.toEqual([]);
      expect(
        breaks(tolerant, tolerant.extend({ note: z.number().optional() }), surface),
      ).not.toEqual([]);
      expect(breaks(tolerant, strict, surface)).not.toEqual([]);
      expect(breaks(strict, strict.strip(), surface)).toEqual([]);
    }
    const added = frames(
      z.object({ type: z.literal("two"), at: z.string() }),
      z.object({ type: z.literal("three") }),
    );
    expect(breaks(base, added, "frames")).toEqual([]);
    expect(breaks(base, added, "output")).not.toEqual([]);
    expect(breaks(added, base, "frames")).not.toEqual([]);
    const nested = (kinds: [string, ...string[]]) =>
      frames(z.object({ type: z.literal("two"), at: z.string(), kind: z.enum(kinds) }));
    expect(breaks(nested(["a"]), nested(["a", "b"]), "frames")).not.toEqual([]);
    expect(
      breaks(
        base,
        frames(z.object({ type: z.literal("two"), at: z.string().optional() })),
        "frames",
      ),
    ).not.toEqual([]);
  });
});
