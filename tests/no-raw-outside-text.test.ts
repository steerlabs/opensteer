import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A value from outside Opensteer (an account's or a person's display name, a conversation's name,
 * a connected agent's own name, an origin) never stands in a sentence, a dialog, an alert or a
 * label as raw text. It goes in as a part (`{ name }`, `{ address }`) through the one family that
 * cleans and marks it: `agentSentence` / `agentText`, `sentenceWith`, `plainSentence`,
 * `phoneSentence` and the web's `SentenceText`. This scans the screens where a chat or a
 * connected agent is named for such a value placed raw:
 * - in a template literal (`${connection.displayName}`);
 * - as a value of `agentWords(...)` or `workWords(...)` (`{ agent }`, `{ account: x.displayName }`);
 * - drawn alone as a JSX child (`{agent}`, `{account.displayName}`).
 *
 * What it still cannot see: a value under another name (it knows the names these screens use for
 * outside values, listed below), one passed through a helper defined elsewhere, and screens not
 * listed here.
 */
const screens = [
  "apps/web/src/components/messaging-page.tsx",
  "apps/web/src/components/mcp-authorization.tsx",
  "apps/web/src/components/computer-channel-setup.tsx",
  "apps/web/src/components/settings/agent-who.tsx",
  "apps/web/src/components/settings/agent-grant-editor.tsx",
  "apps/web/src/components/settings/sections/chat-facts.tsx",
  "apps/web/src/components/settings/sections/connected-agent-page.tsx",
  "apps/web/src/components/settings/sections/external-agents.tsx",
  "apps/mobile/src/screens/settings-messaging.tsx",
  "apps/mobile/src/screens/agent-authorization.tsx",
  "apps/mobile/src/screens/connected-agent.tsx",
  "apps/mobile/src/screens/agent-grant-sections.ts",
  "apps/mobile/src/screens/settings-external-agents-controller.tsx",
];

/** The names these screens give a value from outside. */
const outside =
  /(?<![-\w])(?:displayName|conversationName|conversationId|accountName|accountHandle|origin|agent|agentName|clientName)(?![-\w])/u;
const root = fileURLToPath(new URL("../", import.meta.url));

/** Each place in `source` where an outside value is placed raw, as `line: text`. */
export function rawOutsideText(source: string): readonly string[] {
  const found: string[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const note = (index: number, text: string) =>
    found.push(`${lineOf(index)}: ${text.replace(/\s+/gu, " ").trim()}`);
  for (const match of source.matchAll(/\$\{([^{}]*)\}/gu))
    if (outside.test(match[1]!)) note(match.index, match[0]);
  for (const match of source.matchAll(
    /\b(?:agentWords|workWords)\(\s*"[^"]+"\s*,\s*\{([^{}]*)\}/gu,
  ))
    if (outside.test(match[1]!)) note(match.index, match[0]);
  for (const match of source.matchAll(/>\s*\{\s*([\w.?]+)\s*\}\s*</gu))
    if (outside.test(match[1]!)) note(match.index, match[0]);
  return found;
}

describe("a value from outside never stands raw in a sentence, a dialog or a label", () => {
  it("finds each form it knows", () => {
    expect(
      rawOutsideText(
        [
          "const a = `Actions for ${connection.displayName}`;",
          'const b = agentWords("agent.saved", { agent });',
          'const c = workWords("who.claim", { name: who.clientName });',
          "const d = <h1>{agent}</h1>;",
          'const e = agentText("agent.saved", { agent: { name: agent } });',
          "const f = <SentenceText parts={[{ name: agent }]} />;",
        ].join("\n"),
      ),
    ).toEqual([
      "1: ${connection.displayName}",
      '2: agentWords("agent.saved", { agent }',
      '3: workWords("who.claim", { name: who.clientName }',
      "4: >{agent}<",
    ]);
  });

  it.each(screens)("%s places none raw", (path) => {
    expect(rawOutsideText(readFileSync(`${root}${path}`, "utf8"))).toEqual([]);
  });
});
