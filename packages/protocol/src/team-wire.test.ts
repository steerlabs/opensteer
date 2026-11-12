import { readFileSync, writeFileSync } from "node:fs";
import {
  HostDescriptorSchema,
  minimumTeamApiVersion,
  teamApiVersion,
} from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostApi } from "./host-api.js";
import { teamIdentityRpcNames, teamReadSchemas, TeamCommandSchema } from "./team-api.js";
import { TeamClientFrameSchema, TeamServerFrameSchema } from "./team-chat.js";
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
  TeamClientFrameViewSchema,
  TeamLinkClientFrameViewSchema,
  TeamLinkServerFrameViewSchema,
  TeamServerFrameViewSchema,
} from "./team-views.js";

type JsonSchema = { readonly [key: string]: unknown };
type Direction = "input" | "output";
type Surface = keyof Pick<TeamWire, "input" | "output" | "frames">;
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

const snapshotPath = new URL("./team-wire.snapshot.json", import.meta.url);
const updateVariable = "OPENSTEER_UPDATE_TEAM_WIRE";

function json(schema: z.core.$ZodType): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return rest;
}

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
      (union as z.ZodDiscriminatedUnion).options.flatMap((option) => {
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
    },
    output: {
      ...Object.fromEntries(rpcs.map((name) => [`rpc ${name}`, json(declaration(name).success)])),
      ...commandOptions(hostApi["commands.dispatch"].success),
      "link view": json(TeamLinkViewSchema),
      // Strict: a signed discovery document is verified over exactly what was signed.
      descriptor: json(HostDescriptorSchema),
    },
    frames: Object.fromEntries(
      Object.entries(frameViews).map(([surface, [, view]]) => [surface, json(view)]),
    ),
  };
}

/** What each side writes, and the view its peer reads it with. */
const frameViews = {
  "realtime client frame": [TeamClientFrameSchema, TeamClientFrameViewSchema],
  "realtime server frame": [TeamServerFrameSchema, TeamServerFrameViewSchema],
  "link client frame": [TeamLinkClientFrameSchema, TeamLinkClientFrameViewSchema],
  "link server frame": [TeamLinkServerFrameSchema, TeamLinkServerFrameViewSchema],
} as const;

const record = (value: unknown): JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonSchema) : {};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Names a union member by its literal discriminator, or by its JSON type. */
function memberKey(member: JsonSchema): string {
  const literals = Object.entries(record(member.properties))
    .filter(([, value]) => "const" in record(value))
    .map(([name, value]) => `${name}=${String(record(value).const)}`);
  return literals.length ? literals.join(",") : String(member.type ?? JSON.stringify(member));
}

/**
 * Where a newer reader stops accepting what an older peer sends (`input`) or
 * a newer writer starts sending what an older reader rejects (`output`). New
 * fields must be optional either way; an output may only gain them where its
 * readers ignore unknown fields, and only an input may gain union members or
 * enum values, except the frame types readers skip.
 */
function breakingChanges(
  before: unknown,
  after: unknown,
  direction: Direction,
  path = "",
  skipsUnknownMembers = false,
): string[] {
  if (same(before, after)) return [];
  const old = record(before),
    next = record(after);
  const breaks: string[] = [];
  const keys = new Set([...Object.keys(old), ...Object.keys(next)]);
  for (const key of keys) {
    const at = `${path}/${key}`;
    if (same(old[key], next[key])) continue;
    if (key === "properties") {
      const oldProperties = record(old.properties),
        nextProperties = record(next.properties);
      const required = new Set((next.required as string[] | undefined) ?? []);
      for (const name of Object.keys(oldProperties)) {
        if (!(name in nextProperties)) breaks.push(`${at}/${name} was removed`);
        else
          breaks.push(
            ...breakingChanges(
              oldProperties[name],
              nextProperties[name],
              direction,
              `${at}/${name}`,
            ),
          );
      }
      for (const name of Object.keys(nextProperties)) {
        if (name in oldProperties) continue;
        if (required.has(name)) breaks.push(`${at}/${name} was added as required`);
        else if (direction === "output" && old.additionalProperties === false)
          breaks.push(`${at}/${name} was added where readers refuse unknown fields`);
      }
    } else if (key === "required") {
      const oldRequired = new Set((old.required as string[] | undefined) ?? []);
      const nextRequired = new Set((next.required as string[] | undefined) ?? []);
      const narrowed =
        direction === "input"
          ? [...nextRequired].filter(
              (name) => !oldRequired.has(name) && name in record(old.properties),
            )
          : [...oldRequired].filter((name) => !nextRequired.has(name));
      for (const name of narrowed)
        breaks.push(
          `${path}/properties/${name} became ${direction === "input" ? "required" : "optional"}`,
        );
    } else if (key === "anyOf" || key === "oneOf") {
      const members = (value: unknown) =>
        new Map(
          (Array.isArray(value) ? value : []).map((member) => [
            memberKey(record(member)),
            member as unknown,
          ]),
        );
      const oldMembers = members(old[key]),
        nextMembers = members(next[key]);
      for (const [name, member] of oldMembers) {
        if (!nextMembers.has(name)) breaks.push(`${at}[${name}] was removed`);
        else
          breaks.push(
            ...breakingChanges(member, nextMembers.get(name), direction, `${at}[${name}]`),
          );
      }
      if (direction === "output" && !skipsUnknownMembers)
        for (const name of nextMembers.keys())
          if (!oldMembers.has(name)) breaks.push(`${at}[${name}] was added`);
    } else if (key === "enum") {
      const nextValues = (next.enum as unknown[] | undefined) ?? [];
      const oldValues = (old.enum as unknown[] | undefined) ?? [];
      const widened =
        direction === "input" && oldValues.every((value) => nextValues.includes(value));
      if (!widened) breaks.push(`${at} changed`);
    } else if (key === "items" || key === "additionalProperties") {
      if (key === "additionalProperties" && old[key] === false && !(key in next)) continue;
      if (typeof old[key] === "object" && typeof next[key] === "object")
        breaks.push(...breakingChanges(old[key], next[key], direction, at));
      else breaks.push(`${at} changed`);
    } else breaks.push(`${at} changed`);
  }
  return breaks;
}

function surfaceBreaks(before: unknown, after: unknown, surface: Surface, path = ""): string[] {
  const breaks = breakingChanges(before, after, "input", path);
  if (surface !== "input")
    breaks.push(...breakingChanges(before, after, "output", path, surface === "frames"));
  return [...new Set(breaks)];
}

function wireBreaks(before: TeamWire, after: TeamWire): string[] {
  return (["input", "output", "frames"] as const).flatMap((surface) =>
    Object.entries(before[surface]).flatMap(([name, schema]) =>
      name in after[surface]
        ? surfaceBreaks(schema, after[surface][name], surface, `${surface} ${name}`)
        : [`${surface} ${name} was removed`],
    ),
  );
}

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
        "This breaks peers on the same teamApiVersion. Make it additive, or bump teamApiVersion and decide minimumTeamApiVersion (docs/teams.md#transport-and-versions).",
      ).toEqual([]);
    if (process.env[updateVariable] === "1")
      writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
    else
      expect(
        same(current, committed),
        `The team wire changed compatibly. Record it with ${updateVariable}=1 pnpm exec vitest run packages/protocol/src/team-wire.test.ts`,
      ).toBe(true);
  });

  it("reads every frame with a view that accepts exactly what its writer sends", () => {
    for (const [surface, [writer, view]] of Object.entries(frameViews))
      expect(ignoringStrictness(json(view)), surface).toEqual(ignoringStrictness(json(writer)));
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
