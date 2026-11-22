import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { cardUseConsent } from "../packages/client/src/host/cards.js";
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
  // The documents say what the product does, and are read as such.
  "docs",
];
// AGENTS.md is left out: its rule 8 quotes the very claim, to forbid it.
const documents = ["README.md"];
/** A filled secret, as the claim names it. */
const secret = String.raw`(?:passwords?|logins?|cards?|card numbers?|cvcs?|credentials?|codes?)`;
const who = String.raw`(?:(?:a |the |your |your own |connected )?agents?)`;
const not = String.raw`(?:can(?:no|['’])t|cannot|could(?:n['’]t| not)|won['’]t|will (?:never|not)|never|do(?:es)?(?:n['’]t| not))`;
const look = String.raw`(?:see|sees|read|reads|inspect|access|view|get|receive|learn)`;
const forbidden: readonly RegExp[] = [
  // "Agents never see it", "Agents will never see your card".
  new RegExp(String.raw`${who} ${not} ${look} (?:it|them|the values|[^.]{0,40}?${secret})\b`, "iu"),
  // "No agent can inspect the password once Opensteer fills it."
  new RegExp(String.raw`\bno ${who} (?:can|could|will|ever) ${look}[^.]{0,40}?${secret}\b`, "iu"),
  // "Passwords are invisible to agents", "Your login stays hidden from your own agents."
  new RegExp(
    String.raw`${secret} (?:is|are|stays?|remains?) (?:invisible|hidden|secret|kept) (?:to|from) ${who}`,
    "iu",
  ),
  /\bfill(ed|s)? (it )?without seeing\b/iu,
  /\byou never see (it|them|the values|cookie values)\b/iu,
];
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    if (!/\.(ts|tsx|html|md)$/u.test(name) || /\.test\.|test-support/u.test(path)) return [];
    return [path];
  });
}

describe("what Opensteer says an agent sees of a password", () => {
  it("never says an agent cannot see one, anywhere a person or an agent reads it", () => {
    const found = [
      ...places.flatMap((place) => files(join(root, place))),
      ...documents.map((name) => join(root, name)),
    ].flatMap((path) => {
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

  it("says on every saved-card sheet what the saved-login sheet says", () => {
    const words = cardUseConsent("https://shop.example.com", "2026-11-21T23:46:00.000Z");
    // Opensteer fills it, does not hand it to the agent, and an agent in that page can read it.
    expect(words).toContain("Opensteer fills your saved card on shop.example.com");
    expect(words).toContain("It isn't handed to the agent");
    expect(words).toContain("an agent working in that page can read it");
    expect(words).toContain("a tricked agent could reveal it");
    // What it said before stays: who else reads it, and that it approves no charge.
    expect(words).toContain("The website and its payment provider can read filled details.");
    expect(words).toContain("This does not approve a particular charge.");
    for (const pattern of forbidden) expect(words).not.toMatch(pattern);
  });

  it.each([
    "A connected agent can’t read the filled card number.",
    "A connected agent can't read the filled card number.",
    "Passwords are invisible to agents after they are filled.",
    "Your saved login stays hidden from your own agents.",
    "No agent can inspect the password once Opensteer fills it.",
    "Agents will never see your card.",
    "Your agents cannot access the password it fills.",
  ])("catches the claim in other words: %s", (claim) => {
    expect(forbidden.some((pattern) => pattern.test(claim))).toBe(true);
  });

  it.each([
    "Opensteer fills it into the page and doesn’t hand it to the agent; an agent working in that page can read it.",
    "Results omit cookie values.",
    "An agent working in that page can still read what is on it.",
  ])("lets the truth through: %s", (truth) => {
    expect(forbidden.some((pattern) => pattern.test(truth))).toBe(false);
  });
});
