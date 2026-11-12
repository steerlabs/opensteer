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

type JsonSchema = { readonly [key: string]: unknown };
type Direction = "input" | "output";
interface TeamWire {
  readonly teamApiVersion: number;
  readonly minimumTeamApiVersion: number;
  /** Parsed by the team Host, and by personal Opensteer for `output`. */
  readonly input: Readonly<Record<string, JsonSchema>>;
  /** Parsed by clients and by personal Opensteer. */
  readonly output: Readonly<Record<string, JsonSchema>>;
}

const snapshotPath = new URL("./team-wire.snapshot.json", import.meta.url);
const updateVariable = "OPENSTEER_UPDATE_TEAM_WIRE";

function json(schema: z.core.$ZodType): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return rest;
}

function teamWire(): TeamWire {
  const commands = new Set<string>([
    ...TeamCommandSchema.options.map((option) => option.shape.type.value),
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
  const rpcs = [...Object.keys(teamReadSchemas), ...teamIdentityRpcNames] as const;
  const declaration = (name: string) => hostApi[name as keyof typeof hostApi];
  return {
    teamApiVersion,
    minimumTeamApiVersion,
    input: {
      ...Object.fromEntries(rpcs.map((name) => [`rpc ${name}`, json(declaration(name).payload)])),
      ...commandOptions(hostApi["commands.dispatch"].payload),
      "realtime client frame": json(TeamClientFrameSchema),
      "link client frame": json(TeamLinkClientFrameSchema),
      "link redeem": json(TeamLinkRedeemSchema),
      "link socket headers": json(TeamLinkWebSocketHeadersSchema),
      "link download headers": json(TeamBinaryDownloadHeadersSchema),
      "link upload headers": json(TeamBinaryUploadHeadersSchema),
      "link upload metadata": json(TeamBinaryUploadMetadataSchema),
    },
    output: {
      ...Object.fromEntries(rpcs.map((name) => [`rpc ${name}`, json(declaration(name).success)])),
      ...commandOptions(hostApi["commands.dispatch"].success),
      "realtime server frame": json(TeamServerFrameSchema),
      "link server frame": json(TeamLinkServerFrameSchema),
      "link view": json(TeamLinkViewSchema),
      descriptor: json(HostDescriptorSchema),
    },
  };
}

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
 * Where a newer schema stops accepting what the older peer sends (`input`) or
 * starts sending what the older peer rejects (`output`). New fields must be
 * optional either way; an output may only gain them where its readers ignore
 * unknown fields, and only an input may gain union members or enum values.
 */
function breakingChanges(
  before: unknown,
  after: unknown,
  direction: Direction,
  path = "",
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
      if (direction === "output")
        for (const name of nextMembers.keys())
          if (!oldMembers.has(name)) breaks.push(`${at}[${name}] was added`);
    } else if (key === "enum") {
      const nextValues = (next.enum as unknown[] | undefined) ?? [];
      const oldValues = (old.enum as unknown[] | undefined) ?? [];
      const widened =
        direction === "input" && oldValues.every((value) => nextValues.includes(value));
      if (!widened) breaks.push(`${at} changed`);
    } else if (key === "items" || key === "additionalProperties") {
      if (
        key === "additionalProperties" &&
        direction === "input" &&
        old[key] === false &&
        !(key in next)
      )
        continue;
      if (typeof old[key] === "object" && typeof next[key] === "object")
        breaks.push(...breakingChanges(old[key], next[key], direction, at));
      else breaks.push(`${at} changed`);
    } else breaks.push(`${at} changed`);
  }
  return breaks;
}

function wireBreaks(before: TeamWire, after: TeamWire): string[] {
  return (["input", "output"] as const).flatMap((direction) =>
    Object.entries(before[direction]).flatMap(([surface, schema]) =>
      surface in after[direction]
        ? breakingChanges(schema, after[direction][surface], direction, `${direction} ${surface}`)
        : [`${direction} ${surface} was removed`],
    ),
  );
}

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

  it("tells additive changes from breaking ones in each direction", () => {
    const strict = z.strictObject({ id: z.string(), kind: z.enum(["a", "b"]) });
    const tolerant = z.object({ id: z.string() });
    const breaks = (before: z.ZodType, after: z.ZodType, direction: Direction) =>
      breakingChanges(json(before), json(after), direction);
    const optional = strict.extend({ note: z.string().optional() });
    expect(breaks(strict, optional, "input")).toEqual([]);
    expect(breaks(strict, optional, "output")).not.toEqual([]);
    expect(breaks(tolerant, tolerant.extend({ note: z.string().optional() }), "output")).toEqual(
      [],
    );
    expect(breaks(tolerant, tolerant.extend({ note: z.string() }), "output")).not.toEqual([]);
    expect(breaks(strict, strict.omit({ kind: true }), "input")).not.toEqual([]);
    expect(breaks(strict, strict.extend({ id: z.string().max(4) }), "input")).not.toEqual([]);
    const widened = strict.extend({ kind: z.enum(["a", "b", "c"]) });
    expect(breaks(strict, widened, "input")).toEqual([]);
    expect(breaks(strict, widened, "output")).not.toEqual([]);
    const union = z.discriminatedUnion("type", [z.strictObject({ type: z.literal("one") })]);
    const grown = z.discriminatedUnion("type", [
      ...union.options,
      z.strictObject({ type: z.literal("two") }),
    ]);
    expect(breaks(union, grown, "input")).toEqual([]);
    expect(breaks(union, grown, "output")).not.toEqual([]);
    expect(breaks(grown, union, "input")).not.toEqual([]);
    expect(breaks(strict.nullable(), optional.nullable(), "input")).toEqual([]);
  });
});
