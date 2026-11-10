import { OpensteerError } from "@opensteer/core";
import type * as LibPgQuery from "libpg-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitKnowledgeSql } from "./sql-gate.js";
import {
  castPositions,
  type GateCase,
  grammarDecisions,
  insertShapes,
  otherDecisions,
  prototypeCorpus,
  reviewMatrix,
  wrongAcceptVariants,
} from "./sql-gate-corpus.test-support.js";

const parser = vi.hoisted(() => ({
  transform: undefined as ((tree: unknown) => unknown) | undefined,
}));

vi.mock("libpg-query", async (importOriginal) => {
  const real = await importOriginal<typeof LibPgQuery>();
  return {
    ...real,
    parseSync: (query: string): unknown => {
      const tree: unknown = real.parseSync(query);
      return parser.transform === undefined ? tree : parser.transform(tree);
    },
  };
});

afterEach(() => {
  parser.transform = undefined;
});

async function refusal(
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<OpensteerError | undefined> {
  try {
    await admitKnowledgeSql({ text: sql, parameters });
    return undefined;
  } catch (error) {
    if (error instanceof OpensteerError) return error;
    throw error;
  }
}

async function outcome(sql: string, parameters: readonly unknown[] = []): Promise<string> {
  const error = await refusal(sql, parameters);
  return error === undefined ? "admit" : `${error.reason}`;
}

const corpus: Readonly<Record<string, readonly GateCase[]>> = {
  "the review's 138-case matrix": reviewMatrix,
  "the prototype corpus": prototypeCorpus,
  "variants of the prototype's eleven wrong accepts": wrongAcceptVariants,
  "casts in every position": castPositions,
  "grammar-level forms": grammarDecisions,
  "other decisions": otherDecisions,
  "INSERT shapes": insertShapes,
};
const allCases = Object.values(corpus).flat();

describe("admitKnowledgeSql corpus", () => {
  for (const [group, cases] of Object.entries(corpus)) {
    const rows = cases.map(([sql, expected, why, parameters = []]) => ({
      sql,
      expected,
      why,
      parameters,
    }));
    it.each(rows)(`${group}: $sql`, async ({ sql, expected, parameters }) => {
      expect(await outcome(sql, parameters)).toBe(expected);
    });
  }

  it("refuses in a short sentence that never repeats a literal from the statement", async () => {
    for (const [sql, expected, , parameters] of allCases) {
      if (expected === "admit") continue;
      const error = await refusal(sql, parameters);
      expect(error?.code, sql).toMatch(/^(bad_request|resource_exhausted)$/u);
      expect(error?.message.length, sql).toBeLessThanOrEqual(200);
      for (const [, literal = ""] of sql.matchAll(/'((?:[^']|'')*)'/gu)) {
        if (literal.length >= 3) expect(error?.message, sql).not.toContain(literal);
      }
    }
    const syntax = await refusal("SELECT 'secret-value' FROM WHERE hidden_word");
    expect(syntax?.message).toBe("PostgreSQL can't parse this statement near character 28.");
  });

  it("names a refused function in the product's voice", async () => {
    const error = await refusal("SELECT set_config('knowledge.read_topics', '{x}', true)");
    expect(error).toMatchObject({
      code: "bad_request",
      reason: "function",
      message: "set_config isn't allowed. You can query facts and fact_history.",
    });
  });
});

describe("admitKnowledgeSql result", () => {
  it("returns one statement without its semicolon, safe to wrap after a trailing comment", async () => {
    expect(
      await admitKnowledgeSql({ text: "  SELECT 'é' AS a ;  -- after\n", parameters: [] }),
    ).toEqual({ kind: "select", text: "SELECT 'é' AS a\n" });
    const commented = await admitKnowledgeSql({
      text: "SELECT thing FROM facts -- note",
      parameters: [],
    });
    expect(commented.text).toBe("SELECT thing FROM facts -- note\n");
    expect(
      await outcome(`SELECT q.* FROM (\n${commented.text}) AS q WHERE length(q::text) < 10`),
    ).toBe("admit");
  });

  it("reports the destination keys of an INSERT as PostgreSQL will read them", async () => {
    const text =
      "INSERT INTO facts AS f (property, value, thing, topic, seen_fact_id) VALUES " +
      "('hotel', '\"Hotel C\"', 'trip/kyoto', $1, NULL), " +
      "('budget', '1900', $2, E'tr\\x69ps', 7), " +
      "($3, '2', $$trip/osaka$$, 'plans', NULL) RETURNING f.id, *";
    expect(
      await admitKnowledgeSql({ text, parameters: ["trips", "trip/osaka", "nights"] }),
    ).toEqual({
      kind: "insert",
      text: `${text}\n`,
      rowCount: 3,
      topicIds: ["plans", "trips"],
      keys: [
        { topic: "trips", thing: "trip/kyoto", property: "hotel" },
        { topic: "trips", thing: "trip/osaka", property: "budget" },
        { topic: "plans", thing: "trip/osaka", property: "nights" },
      ],
      suppliesBaseline: true,
    });
    expect(
      await admitKnowledgeSql({
        text: "INSERT INTO facts(topic, thing, property, value) VALUES ('open', 'a', 'b', '1');",
        parameters: [],
      }),
    ).toMatchObject({ rowCount: 1, topicIds: ["open"], suppliesBaseline: false });
  });
});

describe("admitKnowledgeSql limits", () => {
  it("bounds statement bytes, not characters", async () => {
    const quoted = (length: number) => `SELECT '${"a".repeat(length - 9)}'`;
    expect(await outcome(quoted(16_384))).toBe("admit");
    expect(await outcome(quoted(16_385))).toBe("too-large");
    expect(await outcome(`SELECT '${"é".repeat(8_200)}'`)).toBe("too-large");
  });

  it("bounds parameters", async () => {
    expect(
      await outcome(
        "SELECT $64",
        Array.from({ length: 64 }, () => "x"),
      ),
    ).toBe("admit");
    expect(
      await outcome(
        "SELECT $1",
        Array.from({ length: 65 }, () => "x"),
      ),
    ).toBe("too-large");
  });

  it("bounds nesting and recovers after the parser gives up", async () => {
    const nested = (depth: number) => `SELECT ${"lower(".repeat(depth)}'a'${")".repeat(depth)}`;
    expect(await outcome(nested(40))).toBe("admit");
    expect(await outcome(`SELECT 1${"::text".repeat(200)}`)).toBe("too-large");
    expect(await outcome(nested(2_700))).toBe("too-large");
    expect(await outcome("SELECT 1")).toBe("admit");
  });

  it("refuses a NUL character", async () => {
    expect(await outcome("SELECT 1\0")).toBe("syntax");
  });
});

describe("admitKnowledgeSql on syntax trees it does not know", () => {
  type Path = readonly (string | number)[];

  function* objectPaths(value: unknown, path: Path = []): Generator<Path> {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) yield* objectPaths(item, [...path, index]);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    yield path;
    for (const [key, item] of Object.entries(value)) yield* objectPaths(item, [...path, key]);
  }

  function at(tree: unknown, path: Path): Record<string, unknown> {
    let value = tree;
    for (const step of path) value = (value as Record<string | number, unknown>)[step];
    return value as Record<string, unknown>;
  }

  const admittedCases = allCases.filter(([, expected]) => expected === "admit");

  it("refuses every admitted statement once any node gains an unknown field or becomes an unknown node", async () => {
    let mutations = 0;
    for (const [sql, , , parameters] of admittedCases) {
      let original: unknown;
      parser.transform = (tree) => (original = tree);
      expect(await outcome(sql, parameters), sql).toBe("admit");
      for (const path of objectPaths(original)) {
        const target = at(original, path);
        const keys = Object.keys(target);
        const [tag] = keys;
        const wrapped = keys.length === 1 && tag !== undefined && /^[A-Z]/u.test(tag);
        const mutants: ((copy: Record<string, unknown>) => void)[] = [
          (copy) => {
            copy.future_field = true;
          },
        ];
        if (wrapped) {
          mutants.push((copy) => {
            copy.FutureNode = copy[tag];
            delete copy[tag];
          });
        }
        for (const mutate of mutants) {
          parser.transform = (tree) => {
            const copy = structuredClone(tree);
            mutate(at(copy, path));
            return copy;
          };
          mutations += 1;
          expect(await outcome(sql, parameters), `${sql} at ${path.join(".")}`).not.toBe("admit");
        }
      }
    }
    expect(mutations).toBeGreaterThan(5_000);
  });
});
