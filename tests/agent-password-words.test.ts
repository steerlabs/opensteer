import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { passwordSignInPrivacy } from "../packages/client/src/host/passwords.js";

/*
 * AGENTS.md rule 8: never write that an agent cannot see a password or card. Opensteer fills
 * it into the page and does not return it; an agent working in that page can read it. This
 * reads every client, the agents' own tool descriptions and the marketing pages for the
 * claim in the words it has taken before.
 */
const root = join(import.meta.dirname, "..");
const places = [
  "packages/client/src",
  "packages/agent-tools/src",
  "apps/web/src",
  "apps/mobile/src",
  "apps/desktop/src",
  "apps/host/src/mcp",
  "apps/control-plane/src",
  "apps/marketing",
];
const forbidden: readonly RegExp[] = [
  /agents? never sees? (it|them|your (saved )?(password|login|card))/iu,
  /agents? (can(no|')t|cannot|won't|will never|do(es)? not|do(es)?n't) (see|read) (it|them|your (saved )?(password|login|card)|the (password|card|values))/iu,
  /\bfill(ed|s)? (it )?without seeing\b/iu,
  /\byou never see (it|them|the values|cookie values)\b/iu,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    if (!/\.(ts|tsx|html)$/u.test(name) || /\.test\.|test-support/u.test(path)) return [];
    return [path];
  });
}

describe("what Opensteer says an agent sees of a password", () => {
  it("never says an agent cannot see one, anywhere a person or an agent reads it", () => {
    const found = places
      .flatMap((place) => files(join(root, place)))
      .flatMap((path) => {
        const text = readFileSync(path, "utf8").replace(/\s+/gu, " ");
        return forbidden.flatMap((pattern) => {
          const match = pattern.exec(text);
          return match ? [`${relative(root, path)}: ${match[0]}`] : [];
        });
      });
    expect(found).toEqual([]);
  });

  it("says on every sign-in card that an agent working in the page can read it", () => {
    const words = passwordSignInPrivacy("https://github.com");
    expect(words).toContain("an agent working in that page can read it");
    for (const pattern of forbidden) expect(words).not.toMatch(pattern);
    // The sentence it replaced, which rule 8 forbids, is caught.
    expect(
      forbidden.some((pattern) =>
        pattern.test("Agents never see it, but a tricked agent could reveal it."),
      ),
    ).toBe(true);
  });
});
